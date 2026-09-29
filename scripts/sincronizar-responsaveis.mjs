#!/usr/bin/env node
// Sincroniza o Banco de Responsáveis (Notion) com o que está de fato nas
// tarefas dos 29 condomínios e grava o "retrato" inicial de cada tarefa.
//
//  1. Varre o campo Responsável de todas as tarefas (qualquer tipo: opção
//     múltipla, seleção, texto ou Pessoa do Notion) e cadastra no banco os
//     nomes que ainda não existem, com Estado "A classificar" — a equipe
//     revisa no Notion (Tipo, Apelidos, duplicados). Nomes já cadastrados
//     (ou apelidos deles) só têm a coluna informativa "Condomínios" atualizada.
//  2. Grava na aba "_retratos" da planilha o retrato das tarefas que ainda
//     não têm um — sem isso, a PRIMEIRA alteração de cada tarefa não
//     poderia ser comparada com nada e não geraria aviso (ver
//     src/lib/alerta-responsavel.ts). Nunca sobrescreve um retrato existente:
//     quem mantém os retratos em dia é o webhook do Notion.
//
// Importa a lógica de src/lib/*.ts (uma fonte só, a mesma do bot e do
// webhook) — por isso roda com `node --experimental-strip-types` (Node 22).
//
// Variáveis: NOTION_API_KEY (integração do bot, secret NOTION_API_KEY_ALERTAS),
// GOOGLE_SERVICE_ACCOUNT_KEY, REGISTRY_SPREADSHEET_ID (opcional),
// SYNC_DRY_RUN=1 (só mostra o que faria, não grava nada).

import { CONDOMINIOS, NOMES_CONDOMINIOS } from "../src/lib/condominios-notion.ts";
import {
  anexarRetratos,
  atualizarCondominiosResponsavel,
  criarResponsavel,
  idsDosRetratos,
  idsUsuariosResponsaveis,
  indexarResponsaveis,
  listarResponsaveis,
  montarRetrato,
  nomesResponsaveis,
  normalizar,
  notionReq,
  resolverResponsaveis,
} from "../src/lib/alerta-responsavel.ts";
import { obterTokenSheets } from "../src/lib/google-sheets-token.ts";

const CHAVE = process.env.NOTION_API_KEY;
const DRY_RUN = process.env.SYNC_DRY_RUN === "1";
const SPREADSHEET_ID =
  process.env.REGISTRY_SPREADSHEET_ID || "1fEkPgTf6oGYknWEP6zzi8eyBTpoDDQR0goJg1D_Wed0";
const LOTE_RETRATOS = 400;

if (!CHAVE) {
  console.error("NOTION_API_KEY não configurado.");
  process.exit(1);
}

async function paginasDaDatabase(databaseId) {
  const paginas = [];
  let cursor;
  do {
    const res = await notionReq(CHAVE, `databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const json = await res.json();
    paginas.push(...json.results);
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);
  return paginas;
}

async function main() {
  const banco = await listarResponsaveis(CHAVE, { incluirInativos: true });
  console.log(`Banco de Responsáveis: ${banco.length} linha(s).`);

  // nome normalizado -> { nome, condominios:Set, usuarioNotion? }
  const vistos = new Map();
  const retratos = []; // { pageId, retrato }
  const falhas = [];

  for (const [chave, databaseId] of Object.entries(CONDOMINIOS)) {
    const condominio = NOMES_CONDOMINIOS[chave] ?? chave;
    try {
      const paginas = await paginasDaDatabase(databaseId);
      let tarefas = 0;
      for (const pagina of paginas) {
        const props = pagina.properties;
        if (props["Status"]?.type !== "status" || !props["Responsável"]) continue;
        tarefas++;
        retratos.push({ pageId: pagina.id, retrato: montarRetrato(props) });

        const nomes = nomesResponsaveis(props["Responsável"]);
        const usuarios = new Map(
          (props["Responsável"].people ?? [])
            .filter((p) => p.name && p.id)
            .map((p) => [p.name, p.id]),
        );
        for (const nome of nomes) {
          const chaveNome = normalizar(nome);
          const item = vistos.get(chaveNome) ?? { nome, condominios: new Set() };
          item.condominios.add(condominio);
          if (usuarios.has(nome)) item.usuarioNotion = usuarios.get(nome);
          vistos.set(chaveNome, item);
        }
      }
      console.log(`  ${condominio}: ${tarefas} tarefa(s).`);
    } catch (err) {
      falhas.push(condominio);
      console.warn(`  ${condominio}: FALHOU — ${err.message}`);
    }
  }

  // ---- 1. Banco de Responsáveis ----
  let indice = indexarResponsaveis(banco);
  let criados = 0;
  let atualizados = 0;
  for (const item of vistos.values()) {
    const condominios = [...item.condominios]
      .sort((a, b) => a.localeCompare(b, "pt-BR"))
      .join(", ");
    const { ids } = resolverResponsaveis(
      indice,
      [item.nome],
      item.usuarioNotion ? [item.usuarioNotion] : [],
    );
    if (ids.size === 0) {
      criados++;
      console.log(`  + novo responsável: ${item.nome} (${condominios})`);
      if (!DRY_RUN) {
        const id = await criarResponsavel(CHAVE, {
          nome: item.nome,
          condominios,
          usuarioNotion: item.usuarioNotion,
        });
        if (id) {
          banco.push({
            id,
            nome: item.nome,
            tipo: "",
            estado: "A classificar",
            apelidos: [],
            usuariosNotion: item.usuarioNotion ? [item.usuarioNotion] : [],
            condominios,
          });
          indice = indexarResponsaveis(banco);
        }
      }
      continue;
    }
    // Já cadastrado: só mantém a coluna informativa em dia.
    for (const id of ids) {
      const linha = banco.find((r) => r.id === id);
      if (linha && linha.condominios !== condominios) {
        atualizados++;
        if (!DRY_RUN) await atualizarCondominiosResponsavel(CHAVE, id, condominios);
      }
    }
  }
  console.log(`Responsáveis: ${criados} novo(s), ${atualizados} com "Condomínios" atualizado.`);

  // ---- 2. Retratos das tarefas ----
  const chaveGoogle = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!chaveGoogle) {
    console.warn("GOOGLE_SERVICE_ACCOUNT_KEY ausente — pulando os retratos.");
  } else {
    const ctx = { token: await obterTokenSheets(chaveGoogle), spreadsheetId: SPREADSHEET_ID };
    const existentes = new Set(await idsDosRetratos(ctx));
    const faltando = retratos.filter((r) => !existentes.has(r.pageId));
    console.log(`Retratos: ${retratos.length} tarefa(s), ${faltando.length} sem retrato.`);
    if (!DRY_RUN) {
      for (let i = 0; i < faltando.length; i += LOTE_RETRATOS) {
        await anexarRetratos(ctx, faltando.slice(i, i + LOTE_RETRATOS));
      }
    }
  }

  if (falhas.length > 0) {
    console.error(`Condomínios com falha: ${falhas.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
