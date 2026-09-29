// Os 29 condomínios (chave -> database do Notion) e o nome de exibição de
// cada um. Compartilhado pelo bot (webhooks/telegram.ts), pelo webhook do
// Notion e pelo script de sincronização de responsáveis.
//
// Mesma lista de scripts/alertar-tarefas-atrasadas.mjs — duplicada de
// propósito (runtimes diferentes: Cloudflare Worker aqui, Node no GitHub
// Actions lá; mesmo padrão de apps-script/Config.gs vs
// src/lib/report-utils.ts, que também duplicam de propósito por rodarem em
// ambientes separados).
export const CONDOMINIOS: Record<string, string> = {
  "miragio cacupé": "3bae69ba114f804b8f22e2ce314226c8",
  "jazz club": "3bae69ba114f80ea98bde507ad0a0c83",
  "las rozas": "3bbe69ba114f808394e9fa22a19ef6d2",
  vivendas: "3bbe69ba114f80519085edf0384e1e38",
  iconic: "3bbe69ba114f80359dc2c50baa98302f",
  "porto dos açores": "3bbe69ba114f80539d80dae69b97eb43",
  "thai beach": "54ce69ba114f834baeb8817600c95070",
  "bossa nova": "3c3e69ba114f8001a9e0d4ddde3f8fb5",
  "boulevard atlantique": "371dabc8b02d4e40a94a75670e080151",
  "palm beach": "3c3e69ba114f81dfbf61dfee1f3bb64d",
  malibu: "3bbe69ba114f8070b9a9e0c43e39e6f6",
  "encantos do mar": "3c3e69ba114f81739c7dfe12c44934cc",
  "mar aberto": "3c3e69ba114f812c84afc22527799c51",
  contemporâneo: "8a345139cef14f7d8c2777c3e9058675",
  rivière: "3c3e69ba114f81098890f38772e06395",
  "saint exupéry": "3c3e69ba114f810d93b0e9bc37d51b06",
  "la plage": "3c3e69ba114f81f98d72f0337e5cd6cf",
  absoluto: "3c3e69ba114f818a9154c637ec23dd42",
  "dunas do leste": "3c4e69ba114f81bb8b83f4127872e7af",
  "riozinho style": "3c4e69ba114f81e18b67f69ca39fe4b0",
  "pátéo campeche": "3c4e69ba114f81aab7c7e127f4ff0b94",
  infiniti: "3c4e69ba114f810daf4bcdbbb4768619",
  "luiza napoli": "3c4e69ba114f817ebc73c88e47f71b25",
  "cora campeche": "3c4e69ba114f81c196d2e5acbe817fab",
  atlantis: "3c4e69ba114f818b8cade08fea1aba12",
  carrara: "3c4e69ba114f812bb5a2fa3ceb5b4f47",
  "residencial saffira": "3c4e69ba114f8136a0bdc40866f167a4",
  moana: "3bbe69ba114f8019a7c7d2f640784338",
  sunset: "3c4e69ba114f81699ccaeb754c5d7305",
};

// Nome de exibição exato (e valor gravado no campo "Condomínio" do Notion)
// pra cada chave de CONDOMINIOS — checado database por database via API, não
// adivinhado, porque a grafia real do Notion diverge da chave em alguns casos
// (ex.: "Saint Exupery" sem acento, "Páteo Campeche" com acento diferente do
// esperado, "SUNSET" em caixa alta). "Iconic", "Thai Beach" e "Boulevard
// Atlantique" não puderam ser confirmados (databases não compartilhadas com a
// integração usada pra essa checagem) — grafia mais provável usada.
export const NOMES_CONDOMINIOS: Record<string, string> = {
  "miragio cacupé": "Miragio Cacupé",
  "jazz club": "Jazz Club",
  "las rozas": "Las Rozas",
  vivendas: "Vivendas",
  iconic: "Iconic",
  "porto dos açores": "Porto dos Açores",
  "thai beach": "Thai Beach",
  "bossa nova": "Bossa Nova",
  "boulevard atlantique": "Boulevard Atlantique",
  "palm beach": "Palm Beach",
  malibu: "Malibu",
  "encantos do mar": "Encantos do Mar",
  "mar aberto": "Mar Aberto",
  contemporâneo: "Contemporâneo",
  rivière: "Rivière",
  "saint exupéry": "Saint Exupery",
  "la plage": "La Plage",
  absoluto: "Absoluto",
  "dunas do leste": "Dunas do Leste",
  "riozinho style": "Riozinho Style",
  "pátéo campeche": "Páteo Campeche",
  infiniti: "Infiniti",
  "luiza napoli": "Luiza Napoli",
  "cora campeche": "Cora Campeche",
  atlantis: "Atlantis",
  carrara: "Carrara",
  "residencial saffira": "Residencial Saffira",
  moana: "Moana",
  sunset: "SUNSET",
};
