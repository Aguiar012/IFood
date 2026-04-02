// assistente_ia.js
// Assistente IA usando Gemini 2.5 Flash Lite.
// Classifica intencoes, responde duvidas com contexto do usuario,
// e sugere pratos para bloquear baseado no cardapio do IFSP.
// Usado SOMENTE como fallback quando nenhum comando padrao bate.

import { GoogleGenerativeAI } from "@google/generative-ai";

// --- Constantes ---
const LIMITE_POR_USUARIO = 5;   // chamadas IA por usuario por dia
const LIMITE_GLOBAL_DIARIO = 15; // chamadas IA total por dia (RPD = 20, reserva 5)
const NOME_MODELO = "gemini-3.1-flash-preview";

// Pratos comuns do refeitório IFSP (baseado nos cardápios reais)
const PRATOS_CARDAPIO_IFSP = [
    "frango", "frango assado", "filé de frango", "frango grelhado", "frango empanado",
    "carne moída", "carne bovina", "bife", "bife acebolado", "carne assada", "carne de panela",
    "peixe", "filé de peixe", "tilápia", "merluza", "peixe empanado",
    "linguiça", "linguiça toscana", "linguiça calabresa",
    "fígado", "fígado bovino", "fígado acebolado",
    "ovo", "ovo frito", "ovo mexido", "omelete",
    "salsicha", "salsichão",
    "porco", "lombo", "bisteca", "pernil",
    "estrogonofe", "estrogonofe de frango", "estrogonofe de carne",
    "almôndega", "almôndega ao molho",
    "carne seca", "carne seca acebolada",
    "calabresa", "calabresa acebolada",
    "isca de frango", "isca de carne",
    "dobradinha",
    "rabada",
    "mocotó",
    "panqueca", "panqueca de carne",
    "torta", "torta de frango",
    "escondidinho",
    "macarrão", "macarronada",
    "feijoada",
    "arroz carreteiro",
    "virado a paulista",
    "baião de dois"
];

const PROMPT_SUGESTAO_BLOQUEIOS = `Voce sugere pratos para um aluno bloquear no refeitorio do IFSP.

O aluno acabou de bloquear alguns pratos. Sugira OUTROS pratos do cardapio que ele TALVEZ tambem nao coma, baseado no que ele bloqueou.

REGRAS:
- Sugira apenas pratos que fazem sentido com base no que o aluno bloqueou
- NAO repita pratos que o aluno ja bloqueou
- Maximo 5 sugestoes
- Se nao houver sugestoes logicas, responda: NENHUMA
- Responda APENAS com os nomes dos pratos, um por linha, sem numeracao e sem explicacao
- Use nomes curtos e simples (ex: "tilapia" em vez de "file de tilapia grelhado ao molho")

EXEMPLOS:
Aluno bloqueou: peixe
Sugestoes:
tilapia
merluza

Aluno bloqueou: carne moida
Sugestoes:
almondega
estrogonofe de carne
carne seca

Aluno bloqueou: salada
Sugestoes:
NENHUMA

PRATOS COMUNS DO CARDAPIO IFSP (use como referencia):
${PRATOS_CARDAPIO_IFSP.join(", ")}`;

const COMANDOS_VALIDOS = [
    "cancelar", "status", "historico",
    "preferencia", "bloquear", "desbloquear",
    "ativar", "desativar", "ajuda"
];

const PROMPT_SISTEMA = `Você é o assistente do bot de almoço do IFSP.

COMO O SISTEMA FUNCIONA:
- O bot pede almoço AUTOMATICAMENTE de manhã nos dias que o aluno escolheu
- Se o aluno NÃO quer comer, precisa CANCELAR antes
- Pratos bloqueados são pulados automaticamente
- O aluno pode configurar dias, bloquear pratos, ver status e historico

FORMATO DA SUA RESPOSTA:
- Se o usuario quer EXECUTAR uma acao, responda: COMANDO:nome_do_comando
  Comandos validos base: cancelar, status, historico, preferencia, bloquear, desbloquear, ativar, desativar
- Se for para cancelar um dia especifico, responda: COMANDO:cancelar dia_da_semana (ex: COMANDO:cancelar amanha, COMANDO:cancelar quarta)
- Se o usuario faz uma PERGUNTA ou tem DUVIDA, responda em texto curto (1-2 frases) usando os dados do usuario
- NUNCA responda COMANDO:ajuda para perguntas sobre o sistema. So use COMANDO:ajuda se a mensagem nao tem relacao com almoço

EXEMPLOS:
Usuario (cadastrado seg,qua,sex): "amanha vai pedir pra mim?"
Se amanha e segunda: "Sim, amanha e segunda e voce esta cadastrado. O almoço sera pedido automaticamente de manha."
Se amanha e sabado: "Nao, amanha e sabado e voce so esta cadastrado para seg, qua e sex."

Usuario: "nao vou comer amanha" ou "cancelar almoco de terca"
Resposta: COMANDO:cancelar amanha ou COMANDO:cancelar terca

Usuario: "como funciona esse bot?"
Resposta: "O bot pede seu almoço automaticamente nos dias que voce cadastrou (antes das 8h). Se nao quiser comer algum dia, e so cancelar."

Usuario: "quero ver meus dados"
Resposta: COMANDO:status

Usuario: "o que acontece se tiver peixe?"
Se peixe esta bloqueado: "Peixe esta na sua lista de bloqueios, entao o bot nao vai pedir almoço quando o prato do dia for peixe."
Se nao esta bloqueado: "O bot vai pedir normalmente. Se nao gosta de peixe, use o comando 'bloquear' para adicionar."

Usuario: "oi tudo bem?" ou "bom dia"
Resposta: (Responda de forma amigavel, curta e natural, retribuindo a saudacao e perguntando se precisa de ajuda com o almoco)

REGRAS:
- Maximo 2 frases
- Sem emoji
- Use os dados do contexto do usuario
- Seja direto e util`;

// --- Controle de Uso ---
let contadorGlobal = { quantidade: 0, data: "" };
const contadoresPorUsuario = new Map();

function obterDataHoje() {
    return new Date().toISOString().slice(0, 10);
}

function resetarSeNovoDia(contador) {
    const hoje = obterDataHoje();
    if (contador.data !== hoje) {
        contador.quantidade = 0;
        contador.data = hoje;
    }
}

function verificarLimiteUsuario(telefone) {
    const hoje = obterDataHoje();

    resetarSeNovoDia(contadorGlobal);
    if (contadorGlobal.quantidade >= LIMITE_GLOBAL_DIARIO) return false;

    if (!contadoresPorUsuario.has(telefone)) {
        contadoresPorUsuario.set(telefone, { quantidade: 0, data: hoje });
    }
    const contadorUsuario = contadoresPorUsuario.get(telefone);
    resetarSeNovoDia(contadorUsuario);

    return contadorUsuario.quantidade < LIMITE_POR_USUARIO;
}

function registrarUso(telefone) {
    resetarSeNovoDia(contadorGlobal);
    contadorGlobal.quantidade++;

    const contadorUsuario = contadoresPorUsuario.get(telefone);
    if (contadorUsuario) contadorUsuario.quantidade++;
}

// --- Cache Simples ---
const cacheClassificacoes = new Map();
const TAMANHO_MAX_CACHE = 50;

function normalizarParaCache(texto) {
    return texto.toLowerCase().trim().replace(/\s+/g, " ");
}

// O cache so funciona para comandos, nao para respostas contextuais
function buscarNoCache(texto) {
    const chave = normalizarParaCache(texto);
    const resultado = cacheClassificacoes.get(chave);
    if (resultado && resultado.tipo === "comando") return resultado;
    return null;
}

function salvarNoCache(texto, tipo, valor) {
    const chave = normalizarParaCache(texto);
    if (cacheClassificacoes.size >= TAMANHO_MAX_CACHE) {
        const primeiraChave = cacheClassificacoes.keys().next().value;
        cacheClassificacoes.delete(primeiraChave);
    }
    cacheClassificacoes.set(chave, { tipo, valor });
}

// --- Gera contexto do usuario para o prompt ---
const NOMES_DIAS = { 1: "seg", 2: "ter", 3: "qua", 4: "qui", 5: "sex" };

function gerarContextoUsuario(dadosUsuario) {
    if (!dadosUsuario) return "Usuario nao cadastrado.";

    const partes = [];
    partes.push(`Nome: ${dadosUsuario.nome || "desconhecido"} `);

    if (dadosUsuario.diasCadastrados && dadosUsuario.diasCadastrados.length) {
        const nomesDias = dadosUsuario.diasCadastrados.map(d => NOMES_DIAS[d] || d).join(", ");
        partes.push(`Dias cadastrados: ${nomesDias} `);
    } else {
        partes.push("Dias cadastrados: nenhum definido");
    }

    if (dadosUsuario.bloqueios && dadosUsuario.bloqueios.length) {
        partes.push(`Pratos bloqueados: ${dadosUsuario.bloqueios.join(", ")} `);
    }

    if (dadosUsuario.ativo !== undefined) {
        partes.push(`Bot: ${dadosUsuario.ativo ? "ativo" : "pausado"} `);
    }

    if (dadosUsuario.ultimoPedido) {
        partes.push(`Ultimo pedido: ${dadosUsuario.ultimoPedido} `);
    }

    // Dia da semana atual
    const hoje = new Date();
    const diaSemana = hoje.getDay(); // 0=dom, 1=seg...
    const nomeDiaHoje = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"][diaSemana];
    partes.push(`Hoje: ${nomeDiaHoje} (${hoje.toLocaleDateString("pt-BR")})`);

    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);
    const diaSemanaAmanha = amanha.getDay();
    const nomeDiaAmanha = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"][diaSemanaAmanha];
    partes.push(`Amanha: ${nomeDiaAmanha} `);

    return partes.join("\n");
}

// --- Funcao Principal ---

/**
 * Cria o assistente IA.
 * @param {string} chaveApi - Chave da API do Gemini
 * @param {object} logger - Logger (console ou pino)
 * @returns {{ classificarIntencao: Function, sugerirBloqueios: Function }}
 */
export function criarAssistenteIA(chaveApi, logger = console) {
    if (!chaveApi) {
        logger.warn("GEMINI_API_KEY nao definida. IA desabilitada.");
        return {
            classificarIntencao: async () => ({ tipo: "nada", valor: null }),
            sugerirBloqueios: async () => ([])
        };
    }

    const clienteGemini = new GoogleGenerativeAI(chaveApi);
    const modelo = clienteGemini.getGenerativeModel({
        model: NOME_MODELO,
        generationConfig: {
            maxOutputTokens: 150,    // permitir respostas curtas (antes era 20)
            temperature: 0.2,        // determinismo alto
        },
        systemInstruction: PROMPT_SISTEMA,
    });

    /**
     * Classifica a intencao de uma mensagem ou responde duvida.
     * @param {string} mensagem - Texto do usuario
     * @param {string} telefone - Numero do usuario (para rate limit)
     * @param {object} dadosUsuario - Contexto do usuario (nome, dias, bloqueios, etc)
     * @returns {Promise<{tipo: "comando"|"resposta"|"nada", valor: string|null}>}
     */
    async function classificarIntencao(mensagem, telefone, dadosUsuario = null) {
        // 1. Verifica cache (so para comandos)
        const emCache = buscarNoCache(mensagem);
        if (emCache) {
            logger.info(`[IA] Cache hit: "${mensagem}" -> ${emCache.valor} `);
            return emCache;
        }

        // 2. Verifica limites
        if (!verificarLimiteUsuario(telefone)) {
            logger.info(`[IA] Limite atingido para ${telefone} ou global.`);
            return { tipo: "nada", valor: null };
        }

        // 3. Monta o prompt com contexto do usuario
        const contexto = gerarContextoUsuario(dadosUsuario);
        const promptCompleto = `CONTEXTO DO USUARIO: \n${contexto} \n\nMENSAGEM DO USUARIO: "${mensagem}"`;

        // 4. Chama a IA
        try {
            const resultado = await modelo.generateContent(promptCompleto);
            const resposta = resultado.response.text().trim();

            registrarUso(telefone);

            // Verifica se e um comando (formato: COMANDO:nome)
            if (resposta.toUpperCase().startsWith("COMANDO:")) {
                const comando = resposta.slice(8).trim().toLowerCase();
                const comandoBase = comando.split(" ")[0]; // Pegar só a primeira palavra para verificação base  
                if (COMANDOS_VALIDOS.includes(comandoBase)) {
                    const retorno = { tipo: "comando", valor: comando };
                    salvarNoCache(mensagem, "comando", comando);
                    logger.info(`[IA] Comando: "${mensagem}" -> ${comando} `);
                    return retorno;
                }
            }

            // Se nao e comando, e uma resposta contextual
            // Limpa formatacao excessiva
            let textoLimpo = resposta
                .replace(/^COMANDO:\s*/i, "")
                .replace(/\*+/g, "")
                .trim();

            if (textoLimpo.length > 0 && textoLimpo.length < 500) {
                logger.info(`[IA] Resposta: "${mensagem}" -> "${textoLimpo.substring(0, 60)}..."`);
                return { tipo: "resposta", valor: textoLimpo };
            }

            // Resposta vazia ou muito longa
            logger.info(`[IA] Resposta invalida para "${mensagem}"`);
            return { tipo: "nada", valor: null };
        } catch (erro) {
            logger.error(`[IA] Erro ao classificar: ${erro.message || erro} `);
            return { tipo: "nada", valor: null };
        }
    }

    /**
     * Sugere pratos adicionais para bloquear baseado nos que o aluno escolheu.
     * NAO conta no rate limit do usuario (é chamada pelo sistema, não pelo aluno).
     * @param {string[]} itensBloqueados - Pratos que o aluno acabou de bloquear
     * @returns {Promise<string[]>} Lista de sugestões (pode ser vazia)
     */
    async function sugerirBloqueios(itensBloqueados) {
        if (!itensBloqueados || !itensBloqueados.length) return [];

        // Verifica apenas o limite global (não queremos estourar a cota)
        resetarSeNovoDia(contadorGlobal);
        if (contadorGlobal.quantidade >= LIMITE_GLOBAL_DIARIO) {
            logger.info("[IA] Limite global atingido, pulando sugestão de bloqueios.");
            return [];
        }

        const prompt = `O aluno bloqueou: ${itensBloqueados.join(", ")}\nSugestoes:`;

        try {
            const modeloSugestao = clienteGemini.getGenerativeModel({
                model: NOME_MODELO,
                generationConfig: {
                    maxOutputTokens: 100,
                    temperature: 0.3,
                },
                systemInstruction: PROMPT_SUGESTAO_BLOQUEIOS,
            });

            const resultado = await modeloSugestao.generateContent(prompt);
            const resposta = resultado.response.text().trim();

            // Conta no global (mas não no do usuario)
            contadorGlobal.quantidade++;

            // Se Gemini disse NENHUMA, retorna vazio
            if (resposta.toUpperCase().includes("NENHUMA")) {
                logger.info(`[IA] Sugestão bloqueios: nenhuma para [${itensBloqueados.join(", ")}]`);
                return [];
            }

            // Extrai os nomes (um por linha, limpa espaços e numeração)
            const sugestoes = resposta
                .split("\n")
                .map(l => l.replace(/^\d+[\.\)]\s*/, "").trim().toLowerCase())
                .filter(l => l.length > 0 && l.length < 50)
                // Remove itens que o aluno já bloqueou
                .filter(s => !itensBloqueados.some(b =>
                    b.toLowerCase() === s || s.includes(b.toLowerCase()) || b.toLowerCase().includes(s)
                ))
                .slice(0, 5);

            logger.info(`[IA] Sugestão bloqueios: [${itensBloqueados.join(", ")}] -> [${sugestoes.join(", ")}]`);
            return sugestoes;
        } catch (erro) {
            logger.error(`[IA] Erro ao sugerir bloqueios: ${erro.message || erro}`);
            return [];
        }
    }

    /**
     * Usa a IA para interpretar se um texto de resposta (ex: "simmm pfv", "nao quero")
     * e uma confirmacao ou negacao, para contextos onde o bot espera Yes/No.
     */
    async function interpretarConfirmacao(textoUsuario) {
        if (!textoUsuario) return "INCONCLUSIVO";

        resetarSeNovoDia(contadorGlobal);
        if (contadorGlobal.quantidade >= LIMITE_GLOBAL_DIARIO) {
            logger.info("[IA] Limite global atingido, pulando interpretarConfirmacao.");
            return "INCONCLUSIVO";
        }

        const prompt = `Foi perguntado ao usuario para confirmar algo com Sim ou Nao. Ele respondeu: "${textoUsuario}".
A intencao real dele e confirmar (SIM), negar/abortar (NAO), ou esta confuso/INCONCLUSIVO?
Responda APENAS com UMA PALAVRA: SIM, NAO ou INCONCLUSIVO.`;

        try {
            const modeloConf = clienteGemini.getGenerativeModel({
                model: NOME_MODELO,
                generationConfig: { maxOutputTokens: 5, temperature: 0.1 }
            });
            const resultado = await modeloConf.generateContent(prompt);
            contadorGlobal.quantidade++;
            
            const resposta = resultado.response.text().trim().toUpperCase();
            if (resposta.includes("SIM")) return "SIM";
            if (resposta.includes("NAO") || resposta.includes("NÃO")) return "NAO";
            return "INCONCLUSIVO";
        } catch (erro) {
            logger.error(`[IA] Erro ao interpretar confirmacao: ${erro.message || erro}`);
            return "INCONCLUSIVO";
        }
    }

    return { classificarIntencao, sugerirBloqueios, interpretarConfirmacao };
}
