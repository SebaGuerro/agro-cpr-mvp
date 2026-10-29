// pt-BR labels for the API's codes. The API speaks English; the screens speak Portuguese.

export const ROLE_LABEL: Record<string, string> = {
  PRODUCER: "Produtor",
  WAREHOUSE: "Armazém",
  BUYER: "Comprador",
  FINANCIER: "Financiador",
  INSURER: "Seguradora",
  ADMIN: "Administrador",
};

export const ORG_KIND_LABEL: Record<string, string> = {
  PLATFORM: "Plataforma",
  PRODUCER: "Produtor",
  WAREHOUSE: "Armazém",
  BUYER: "Comprador",
  FINANCIER: "Financiador",
  INSURER: "Seguradora",
};

export const CROP_LABEL: Record<string, string> = { SOJA: "Soja", MILHO: "Milho", TRIGO: "Trigo", SORGO: "Sorgo", FEIJAO: "Feijão" };
export const CROPS = ["SOJA", "MILHO", "TRIGO", "SORGO", "FEIJAO"] as const;

export const STAGE_LABEL: Record<string, string> = {
  CREATED: "Criado",
  PLANTED: "Plantado",
  HARVEST_PLANNED: "Colheita planejada",
  HARVESTING: "Em colheita",
  DELIVERING: "Entregando",
  DELIVERED: "Entregue",
  CLOSED: "Encerrado",
};

export const CPR_STATUS_LABEL: Record<string, string> = { NONE: "Sem CPR", ISSUED: "Emitida", FUNDED: "Desembolsada", SETTLED: "Liquidada" };

export const EVENT_LABEL: Record<string, string> = {
  PLOT_REGISTERED: "Talhão cadastrado",
  SOIL_ANALYSIS_ATTACHED: "Análise de solo",
  CPR_ISSUED: "CPR emitida",
  FUNDING_DISBURSED: "Desembolso",
  PLANTING_RECORDED: "Plantio",
  INPUT_APPLICATION_RECORDED: "Aplicação de insumo",
  HARVEST_PLANNED: "Colheita planejada",
  HARVEST_STARTED: "Início da colheita",
  TRUCK_DISPATCHED: "Caminhão despachado",
  TRUCK_ARRIVED: "Caminhão chegou",
  GRAIN_RECEIVED: "Grão recebido e classificado",
  CDA_ISSUED: "CDA/WA emitido",
  GRAIN_RELEASED: "Grão liberado",
  SALE_RECORDED: "Venda",
  INFO_REQUESTED: "Pedido de informação",
  CPR_SETTLED: "CPR liquidada",
  EVENT_CORRECTED: "Correção",
  EVENT_VOIDED: "Anulação",
  POLICY_ISSUED: "Apólice emitida",
  CLAIM_FILED: "Sinistro comunicado",
  CLAIM_SETTLED: "Sinistro regulado",
};

export const ALERT_LABEL: Record<string, string> = {
  PLANTED_OUTSIDE_WINDOW: "Plantio fora da janela",
  PLANTING_WINDOW_MISSED: "Janela de plantio perdida",
  APPLICATION_MISSING: "Aplicação não registrada",
  APPLICATION_LATE: "Aplicação fora do prazo",
  HARVEST_NOT_PLANNED: "Colheita sem plano",
  HARVEST_OVERDUE: "Colheita atrasada",
  DELIVERY_OVERDUE: "Caminhão atrasado",
  DELIVERY_SHORTFALL: "Entrega abaixo do contratado",
  QUALITY_TICKET_MISMATCH: "Desconto do ticket diverge da tabela",
  CPR_DUE_SOON: "Vencimento da CPR",
  INFO_REQUEST_OPEN: "Pedido de informação aberto",
  CLAIM_OPEN: "Sinistro aberto",
  CLAIM_UNANSWERED: "Sinistro sem resposta",
  ANCHOR_FAILED: "Falha no registro em blockchain",
};

export const SEVERITY_LABEL: Record<string, string> = { INFO: "Info", WARNING: "Atenção", HIGH: "Alta" };
export const SEVERITY_COLOR: Record<string, string> = { INFO: "blue", WARNING: "yellow", HIGH: "red" };

export const DIMENSION_LABEL: Record<string, string> = {
  PLANTING_WINDOW: "Janela de plantio",
  INPUT_COMPLIANCE: "Insumos",
  HARVEST_DELIVERY: "Colheita e entrega",
};

export const GRADE_COLOR: Record<string, string> = { A: "green", B: "lime", C: "orange", D: "red" };

export const CATEGORY_LABEL: Record<string, string> = {
  SEED: "Semente / tratamento",
  FERTILIZER: "Fertilizante",
  HERBICIDE: "Herbicida",
  INSECTICIDE: "Inseticida",
  FUNGICIDE: "Fungicida",
  OTHER: "Outro",
};

export const COVERAGE_LABEL: Record<string, string> = {
  CUSTEIO: "Custeio",
  PRODUTIVIDADE: "Produtividade",
  FATURAMENTO: "Faturamento",
  MULTIRRISCO: "Multirrisco",
};

export const CAUSE_LABEL: Record<string, string> = {
  SECA: "Seca / estiagem",
  GEADA: "Geada",
  GRANIZO: "Granizo",
  EXCESSO_CHUVA: "Excesso de chuva",
  PRAGA_DOENCA: "Praga ou doença",
  INCENDIO: "Incêndio",
  OUTRO: "Outro",
};

export const INFO_TOPIC_LABEL: Record<string, string> = {
  PLANTING: "Plantio",
  INPUTS: "Insumos",
  HARVEST: "Colheita",
  DELIVERY: "Entrega",
  DOCUMENTS: "Documentos",
  OTHER: "Outro",
};

/** Problem codes from the API, in Portuguese. The API's English detail is shown after it. */
export const PROBLEM_LABEL: Record<string, string> = {
  UNAUTHENTICATED: "Sessão expirada; entre novamente",
  FORBIDDEN_ROLE: "Seu perfil não pode fazer isso",
  FORBIDDEN_ORG: "Sua organização não pode fazer isso",
  VALIDATION_FAILED: "Dados inválidos",
  NOT_FOUND: "Não encontrado",
  INVALID_TRANSITION: "Fora de ordem para a situação atual",
  CPR_ALREADY_EXISTS: "Este ciclo já tem CPR",
  ISSUED_ABOVE_ELIGIBLE: "Volume acima do elegível",
  WRONG_WAREHOUSE: "Armazém diferente do designado na CPR",
  DELIVERY_NOT_FOUND: "Caminhão não encontrado",
  QUANTITY_EXCEEDS_AVAILABLE: "Quantidade acima do disponível",
  EVIDENCE_REQUIRED: "Envie a evidência primeiro",
  EVENT_ID_CONFLICT: "Registro duplicado com outro conteúdo",
  CORRECTION_BREAKS_STREAM: "A correção invalida registros posteriores",
  BATCH_ALREADY_ANCHORED: "O lote já foi para a blockchain",
  BATCH_HAS_DEPENDENTS: "Há registros posteriores que dependem deste lote",
  LAND_ALREADY_REGISTERED: "CAR já cadastrado por outro produtor",
  CYCLE_ALREADY_EXISTS: "Já existe ciclo neste talhão e safra",
};

export const options = (labels: Record<string, string>, keys?: readonly string[]) =>
  (keys ?? Object.keys(labels)).map((value) => ({ value, label: labels[value] ?? value }));
