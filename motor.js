// Motor de regras - roda no GitHub Actions (Node 18+, sem dependências).
// 1) Busca no ThingSpeak as coletas novas e guarda em dados.json
// 2) Apaga do dados.json o que passou do período definido em config.json
// 3) Avalia as regras do config.json sobre a última coleta conhecida
// 4) Registra em alertas.log e avisa pelo ntfy (só quando a condição MUDA)

const fs = require("fs");

const NTFY_TOPIC = process.env.NTFY_TOPIC || "";            // vem dos Secrets do GitHub
const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";

const OPERADORES = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b
};
const NOMES = { temp: "Temperatura", umid: "Umidade", luz: "Luminosidade", falha: "Falha" };

const ler = (arquivo, padrao) => {
  try { return JSON.parse(fs.readFileSync(arquivo, "utf8")); } catch { return padrao; }
};
const agora = () => new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

// Busca as coletas do ThingSpeak que ainda não estão em dados.json
async function buscarNovos(config, dados) {
  const ultimoId = dados.length ? dados[dados.length - 1].id : 0;
  const url = "https://api.thingspeak.com/channels/" + config.channel_id + "/feeds.json?results=200";
  const r = await fetch(url);
  if (!r.ok) throw new Error("ThingSpeak respondeu HTTP " + r.status);
  const json = await r.json();
  return (json.feeds || [])
    .filter(f => f.entry_id > ultimoId)
    .map(f => ({
      id: f.entry_id,
      t: f.created_at,
      temp: parseFloat(f.field1),
      umid: parseFloat(f.field2),
      luz: parseFloat(f.field3),
      falha: f.field4 === "1" ? 1 : 0
    }));
}

// Descobre quais regras mudaram de situação (normal -> disparada ou o contrário)
function avaliar(config, atual, estado) {
  const eventos = [];
  for (const regra of config.regras || []) {
    if (!regra.ativo) { estado[regra.id] = false; continue; }
    const comparar = OPERADORES[regra.operador];
    const valor = atual[regra.campo];
    if (!comparar || valor == null || Number.isNaN(valor)) continue;

    const disparada = comparar(valor, Number(regra.valor));
    const estavaDisparada = !!estado[regra.id];
    if (disparada && !estavaDisparada) eventos.push({ tipo: "ALERTA", regra, valor });
    if (!disparada && estavaDisparada && config.avisar_normalizacao) eventos.push({ tipo: "NORMALIZADO", regra, valor });
    if (!disparada && estavaDisparada && !config.avisar_normalizacao) estado[regra.id] = false;
  }
  return eventos;
}

async function enviarNtfy(titulo, mensagem, prioridade, tags) {
  if (!NTFY_TOPIC) {
    console.log("NTFY_TOPIC não definido: o alerta foi apenas registrado.");
    return true;  // considera tratado, para não repetir a cada execução
  }
  const r = await fetch(NTFY_SERVER + "/" + NTFY_TOPIC, {
    method: "POST",
    headers: { Title: titulo, Priority: prioridade, Tags: tags },  // cabeçalhos só com ASCII
    body: mensagem
  });
  return r.ok;
}

async function main() {
  const config = ler("config.json", null);
  if (!config) throw new Error("config.json não encontrado ou inválido");

  let dados = ler("dados.json", []);
  const estado = ler("estado.json", {});

  // 1) e 2) dados novos + remoção dos antigos
  const novos = await buscarNovos(config, dados);
  dados = dados.concat(novos);
  const limite = Date.now() - config.retencao_dias * 86400000;
  const antes = dados.length;
  dados = dados.filter(d => new Date(d.t).getTime() >= limite);
  fs.writeFileSync("dados.json", "[\n" + dados.map(d => JSON.stringify(d)).join(",\n") + "\n]\n");

  // 3) e 4) regras
  const linhasNovas = [];
  const atual = dados[dados.length - 1];
  if (atual) {
    for (const ev of avaliar(config, atual, estado)) {
      const alerta = ev.tipo === "ALERTA";
      const mensagem = ev.regra.nome + " (" + NOMES[ev.regra.campo] + " = " + ev.valor +
        "; regra: " + ev.regra.operador + " " + ev.regra.valor + ")" + (alerta ? "" : " - voltou ao normal");
      const enviado = await enviarNtfy(
        alerta ? "Alerta IoT" : "Alerta IoT - normalizado",
        mensagem,
        alerta ? (ev.regra.prioridade || "default") : "low",
        alerta ? "rotating_light" : "white_check_mark"
      );
      if (enviado) estado[ev.regra.id] = alerta;  // se o envio falhar, tenta de novo na próxima execução
      linhasNovas.push(agora() + " | " + ev.tipo + " | " + ev.regra.id + " | " + mensagem + (enviado ? "" : " (ntfy falhou)"));
    }
  } else {
    console.log("Ainda não há coletas para avaliar.");
  }

  // Registro em alertas.log (guarda as últimas 500 linhas)
  let linhas = fs.existsSync("alertas.log") ? fs.readFileSync("alertas.log", "utf8").split("\n").filter(Boolean) : [];
  linhas = linhas.concat(linhasNovas).slice(-500);
  fs.writeFileSync("alertas.log", linhas.length ? linhas.join("\n") + "\n" : "");
  fs.writeFileSync("estado.json", JSON.stringify(estado, null, 2) + "\n");

  console.log(novos.length + " coleta(s) nova(s); " + (antes - dados.length) + " removida(s) por idade; " +
    linhasNovas.length + " evento(s) de alerta.");
}

main().catch(e => { console.error(e); process.exit(1); });
