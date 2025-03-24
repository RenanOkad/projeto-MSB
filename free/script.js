const { chromium } = require('playwright');
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { exec } = require('child_process'); // Adicionado para gerenciar processos do sistema
const schedule = require('node-schedule'); // Adicionado para agendamento
const fs = require('fs'); // Adicionado para persistência dos contadores

// Configurações básicas
const TELEGRAM_TOKEN = "7353153409:AAFCy1qUjxzZSgT_XUoOScR1Rjl4URtfzk8"; // Token do bot do Telegram
const CHANNEL_ID = "1750232012"; // ID ou nome do canal Telegram ID-Bot: 1750232012, ID Grupo: -1002223861805, ID Grupo VIP: -1002357054147
// Lista de URLs iniciais para tentar encontrar o botão de login
const INITIAL_URLS = [
    "https://www.seguro.bet.br",
    "https://www.seguro.bet.br/cassino/slots/all?btag=2329948",
    // Adicione mais URLs aqui no futuro, por exemplo:
    // "https://www.seguro.bet.br/outra-pagina",
    // "https://www.seguro.bet.br/nova-entrada"
];
const GAME_URL = "https://www.seguro.bet.br/cassino/slots/320/320/pragmatic-play-live/56977-420031975-treasure-island";
const JSON_URL = "https://games.pragmaticplaylive.net/api/ui/stats?JSESSIONID={}&tableId=a10megasicbaca10&noOfGames=500";
const SESSION_REFRESH_INTERVAL = 720 * 1000; // 12 minutos (usado como fallback, mas não será o gatilho principal)
const ERROR_MESSAGE_COOLDOWN = 300 * 1000; // 5 minutos

// Configuração de logging com console e arquivo
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} - ${level.toUpperCase()} - ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'signal_system.log' }),
        new winston.transports.Console() // Adiciona logs no console para Discloud
    ]
});

// Controle de mensagens de erro
const lastErrorMessageTime = {};
let isSystemInErrorState = false; // Flag para controlar o estado de erro e mensagens no Telegram

// Função para carregar os contadores do arquivo
function loadStats() {
    try {
        if (fs.existsSync('stats.json')) {
            const data = fs.readFileSync('stats.json', 'utf8');
            const parsed = JSON.parse(data);
            return {
                winsInitial: parsed.winsInitial || 0,
                winsGale1: parsed.winsGale1 || 0,
                winsGale2: parsed.winsGale2 || 0,
                losses: parsed.losses || 0,
                lastResetDate: parsed.lastResetDate || new Date().toDateString(),
                weeklyStats: parsed.weeklyStats || { wins: 0, losses: 0, initialWins: 0, startDate: new Date().toISOString() }
            };
        }
    } catch (error) {
        logger.error(`Erro ao carregar stats.json: ${error.message}`);
    }
    return {
        winsInitial: 0,
        winsGale1: 0,
        winsGale2: 0,
        losses: 0,
        lastResetDate: new Date().toDateString(),
        weeklyStats: { wins: 0, losses: 0, initialWins: 0, startDate: new Date().toISOString() }
    };
}

// Função para salvar os contadores no arquivo
function saveStats(stats) {
    try {
        fs.writeFileSync('stats.json', JSON.stringify(stats, null, 2));
        logger.info('Contadores salvos em stats.json');
    } catch (error) {
        logger.error(`Erro ao salvar stats.json: ${error.message}`);
    }
}

// Carrega os contadores na inicialização
let stats = loadStats();
let lastResetDate = stats.lastResetDate;
let weeklyStats = stats.weeklyStats;

function canSendErrorMessage(message) {
    const currentTime = Date.now();
    if (!lastErrorMessageTime[message] || (currentTime - lastErrorMessageTime[message]) >= ERROR_MESSAGE_COOLDOWN) {
        lastErrorMessageTime[message] = currentTime;
        return true;
    }
    return false;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Função para tentar múltiplos seletores (CSS ou XPath)
async function waitForElement(page, selectors, timeout = 30000) {
    for (const selector of selectors) {
        try {
            logger.info(`Tentando localizar elemento com seletor: ${selector}`);
            let element;
            if (selector.startsWith('xpath=')) {
                const xpath = selector.replace('xpath=', '');
                element = await page.waitForSelector(`xpath=${xpath}`, { state: 'visible', timeout });
            } else if (selector.includes(':has-text(')) {
                const text = selector.match(/:has-text\("([^"]+)"\)/)?.[1];
                if (text) {
                    element = await page.waitForSelector(`text="${text}"`, { state: 'visible', timeout });
                }
            } else {
                element = await page.waitForSelector(selector, { state: 'visible', timeout });
            }
            if (element) {
                logger.info(`Elemento encontrado com seletor: ${selector}`);
                return element;
            }
        } catch (error) {
            logger.warn(`Falha ao encontrar elemento com seletor ${selector}: ${error.message}`);
        }
    }
    throw new Error(`Nenhum dos seletores fornecidos foi encontrado: ${selectors.join(', ')}`);
}

// Função para matar processos Chrome pendentes (substituindo psutil com child_process)
async function killChromeProcesses() {
    try {
        // Comando condicional para Windows (taskkill) ou Linux/Mac (pkill)
        const command = process.platform === 'win32' ? 'taskkill /IM chrome.exe /F || taskkill /IM chromium.exe /F' : 'pkill -9 chrome || pkill -9 chromium';
        exec(command, (err) => {
            if (err) {
                logger.warn(`Erro ao encerrar processos Chrome: ${err.message}`);
            } else {
                logger.info('Processos Chrome encerrados com sucesso.');
            }
        });
    } catch (error) {
        logger.warning(`Erro ao encerrar processos Chrome: ${error.message}`);
    }
}

// Função para capturar o JSESSIONID
async function getJSessionId() {
    // Tenta matar processos pendentes antes de iniciar
    await killChromeProcesses();

    let browser = null;
    let page = null;
    const maxAttempts = 3; // Número máximo de tentativas para lidar com erros de inicialização
    let attempt = 0;

    while (attempt < maxAttempts) {
        try {
            logger.info(`Tentativa ${attempt + 1}/${maxAttempts} para inicializar o navegador...`);
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-setuid-sandbox', // Necessário em contêineres Linux
                    '--disable-dev-shm-usage'   // Evita problemas de memória compartilhada
                ]
            });

            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                permissions: ['geolocation'],
                geolocation: { latitude: -23.5505, longitude: -46.6333 }
            });

            page = await context.newPage();
            logger.info("Navegador inicializado com sucesso.");
            break;
        } catch (error) {
            logger.warn(`Erro ao inicializar o navegador: ${error.message}. Tentando novamente em 5 segundos...`);
            await delay(5000);
            attempt++;
        }
    }

    if (!browser || !page) {
        logger.error("Falha ao inicializar o navegador ou página após todas as tentativas.");
        return null;
    }

    let sessionId = null;
    try {
        // Lista de seletores para o botão "Entrar"
        const enterSelectors = [
            'button.v3-btn:nth-child(1)', // CSS: seletor específico
            'button.v3-btn',
            'xpath=/html/body/div[2]/div[1]/div/div[2]/header/div[2]/div/div/div/div/div[3]/div/div/div/div/div/button[1]',
            'button:has-text("Entrar")'
        ];

        let enterButton = null;
        let currentUrl = null;

        // Tenta cada URL inicial até encontrar o botão "Entrar"
        for (const url of INITIAL_URLS) {
            logger.info(`Acessando ${url}...`);
            const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
            logger.info(`Status da resposta: ${response.status()}`);
            await delay(5000);
            logger.info(`URL atual: ${page.url()}`);

            const pageContent = await page.content();
            if (pageContent.includes('Error 1009') || pageContent.includes('The owner of this website has banned')) {
                logger.error("Erro 1009: Bloqueio geográfico detectado. Verifique o proxy.");
                return null;
            }

            logger.info(`Tentando localizar o botão 'Entrar' em ${url}...`);
            try {
                enterButton = await waitForElement(page, enterSelectors, 10000); // Timeout de 10 segundos
                currentUrl = url;
                break; // Botão encontrado, sair do loop
            } catch (error) {
                logger.warn(`Botão 'Entrar' não encontrado em ${url}: ${error.message}`);
            }
        }

        // Verifica se o botão foi encontrado em alguma das URLs
        if (!enterButton) {
            logger.error(`Botão 'Entrar' não encontrado em nenhuma das URLs: ${INITIAL_URLS.join(', ')}`);
            throw new Error("Botão 'Entrar' não encontrado.");
        }

        logger.info(`Botão 'Entrar' encontrado com sucesso em ${currentUrl}!`);

        // Aceita os cookies
        logger.info("Tentando aceitar os cookies...");
        const cookieSelectors = [
            '#btn-sim', // CSS: seletor por ID do botão de cookies
            'xpath=/html/body/div[5]/div/button[2]',
            'button:has-text("Aceitar")'
        ];
        const cookieButton = await waitForElement(page, cookieSelectors, 30000);
        await cookieButton.click();
        logger.info("Cookies aceitos!");

        await delay(3000);

        // Clica no botão "Entrar"
        logger.info("Tentando clicar no botão 'Entrar'...");
        await enterButton.click();
        logger.info("Botão 'Entrar' clicado!");

        await delay(5000);

        // Preenche o campo de nome de usuário com seletores alternativos
        logger.info("Tentando preencher o campo de usuário...");
        const usernameSelectors = [
            '#username',
            'xpath=/html/body/div[11]/div/div/div/div/div/form/div[1]/div[2]/div/div/input',
            'xpath=/html/body/div[13]/div/div/div/div/div/form/div[1]/div[2]/div/div/input',
            'xpath=/html/body/div[8]/div/div/div/div/div/form/div[1]/div[2]/div[1]/div/input',
            'input[name="username"]',
            'input[placeholder="E-mail"]'
        ];
        const usernameInput = await waitForElement(page, usernameSelectors, 30000);
        await usernameInput.fill('renanokada2000@gmail.com'); // Substitua por uma variável de ambiente
        logger.info("Usuário preenchido!");

        await delay(2000);

        // Trata pop-up de permissão de localização (mantido do código original)
        const permissionSelectors = [
            'text="Permitir desta vez"',
            'button:has-text("Permitir")'
        ];
        try {
            const permissionButton = await page.waitForSelector(permissionSelectors[0], { state: 'visible', timeout: 5000 });
            if (permissionButton) {
                await permissionButton.click();
                logger.info("Permissão de localização concedida!");
            }
        } catch (error) {
            logger.info("Pop-up de permissão não encontrado ou já foi tratado.");
        }

        // Preenche o campo de senha com seletores alternativos
        logger.info("Tentando preencher o campo de senha...");
        const passwordSelectors = [
            '#password',
            'xpath=/html/body/div[11]/div/div/div/div/div/form/div[2]/div[2]/div/div/span/input',
            'xpath=/html/body/div[13]/div/div/div/div/div/form/div[2]/div[2]/div/div/span/input',
            'xpath=/html/body/div[8]/div/div/div/div/div/form/div[2]/div[2]/div[1]/div/span/input',
            'input[name="password"]',
            'input[placeholder="Senha"]'
        ];
        const passwordInput = await waitForElement(page, passwordSelectors, 30000);
        await passwordInput.fill('Fabiodinha@2014'); // Substitua por uma variável de ambiente
        logger.info("Senha preenchida!");

        await delay(2000);

        // Clica no botão de login com seletores alternativos
        logger.info("Tentando clicar no botão de login...");
        const loginSelectors = [
            'xpath=/html/body/div[12]/div/div/div/div/div/form/button',
            'xpath=/html/body/div[11]/div/div/div/div/div/form/button',
            'xpath=/html/body/div[13]/div/div/div/div/div/form/button',
            'button[type="submit"]',
            'button:has-text("Entrar")'
        ];
        const loginButton = await waitForElement(page, loginSelectors, 30000);
        await loginButton.click();
        logger.info("Botão de login clicado!");

        await delay(5000);

        // Acessa a página do jogo
        logger.info(`Acessando ${GAME_URL}...`);
        await page.goto(GAME_URL, { waitUntil: 'networkidle', timeout: 90000 });
        logger.info(`URL atual após navegação para jogo: ${page.url()}`);

        // Captura o JSESSIONID usando requestfinished com flag de parada
        let sessionId = null;
        let isSessionIdCaptured = false;

        page.on('requestfinished', async (request) => {
            if (isSessionIdCaptured) return; // Para o monitoramento após capturar

            const url = request.url();
            if ((url.toLowerCase().includes('games.pragmaticplaylive.net') || url.toLowerCase().includes('client.pragmaticplaylive')) && url.toLowerCase().includes('jsessionid')) {
                logger.info(`Requisição capturada: ${request.url()}`);
                const match = url.match(/JSESSIONID=([^&]+)/i);
                if (match) {
                    sessionId = match[1];
                    logger.info(`JSESSIONID capturado: ${sessionId}`);
                    isSessionIdCaptured = true;
                }
            }
        });

        // Aguarda até que o JSESSIONID seja capturado ou um tempo razoável
        const maxWaitTime = 30000; // 30 segundos como limite seguro (ajustável)
        const startTime = Date.now();
        while (!sessionId && (Date.now() - startTime) < maxWaitTime) {
            await delay(100); // Checa a cada 100ms
        }

        if (!sessionId) {
            logger.error("JSESSIONID não capturado dentro do tempo limite.");
            throw new Error("Falha ao capturar JSESSIONID.");
        }

        return sessionId;
    } catch (error) {
        logger.error(`Erro ao capturar JSESSIONID: ${error.message}`);
        logger.error(`Stack trace: ${error.stack}`);
        return null;
    } finally {
        if (browser) {
            try {
                await browser.close();
                logger.info("Navegador encerrado com sucesso.");
            } catch (error) {
                logger.warn(`Erro ao encerrar navegador: ${error.message}`);
            } finally {
                // Garante que o processo seja encerrado
                await killChromeProcesses();
            }
        }
    }
}

// Função para acessar o JSON com verificação de falha
async function fetchGameHistory(sessionId) {
    try {
        const url = JSON_URL.replace("{}", sessionId);
        const response = await axios.get(url, { timeout: 10000 });
        logger.info("Histórico de jogos obtido com sucesso.");
        return response.data;
    } catch (error) {
        logger.error(`Erro ao acessar JSON: ${error.message} (Status: ${error.response?.status})`);
        return null;
    }
}

// Função para construir padrões
function buildPatterns(history, minSeq = 4, maxSeq = 9) {
    const patterns = {};
    for (let seqLength = minSeq; seqLength <= maxSeq; seqLength++) {
        for (let i = 0; i < history.length - seqLength; i++) {
            const sequence = history.slice(i, i + seqLength).map(game => game.result);
            const nextResult = history[i + seqLength].result;
            const sequenceKey = sequence.join(',');

            if (!patterns[sequenceKey]) patterns[sequenceKey] = { results: {}, sequence: sequence };
            patterns[sequenceKey].results[nextResult] = (patterns[sequenceKey].results[nextResult] || 0) + 1;
        }
    }
    return patterns;
}

// Função para prever o próximo resultado
function predictNext(sequence, patterns, minConfidence = 0.70, minOccurrences = 4) {
    const sequenceKey = sequence.join(',');
    if (!patterns[sequenceKey]) return [null, null, null, null];

    const resultCounts = patterns[sequenceKey].results;
    const total = Object.values(resultCounts).reduce((sum, count) => sum + count, 0);

    if (total < minOccurrences) return [null, null, null, null];

    const probabilities = {};
    for (const result in resultCounts) {
        probabilities[result] = resultCounts[result] / total;
    }

    const bestResult = Object.keys(probabilities).reduce((a, b) => probabilities[a] > probabilities[b] ? a : b);
    const confidence = probabilities[bestResult];
    const detectedSequence = patterns[sequenceKey].sequence;

    // Para sequências maiores (8 e 9), exigimos confiança mínima de 85%
    const seqLength = sequence.length;
    const requiredConfidence = (seqLength >= 8) ? 0.85 : minConfidence;

    return confidence >= requiredConfidence ? [bestResult, confidence, total, detectedSequence] : [null, null, null, null];
}

// Funções para enviar mensagens ao Telegram
async function sendSignalDefault(bot, message) {
    try {
        await bot.sendMessage(CHANNEL_ID, message);
        logger.info(`Sinal enviado: ${message}`);
    } catch (error) {
        logger.error(`Erro ao enviar sinal para o Telegram: ${error.message}`);
    }
}

async function sendSystemStatus(bot, message) {
    try {
        await bot.sendMessage(CHANNEL_ID, message);
        logger.info(`Status do sistema enviado: ${message}`);
    } catch (error) {
        logger.error(`Erro ao enviar status para o Telegram: ${error.message}`);
    }
}

// Função para enviar e fixar o relatório diário
async function sendDailyReport(bot) {
    const currentDate = new Date().toDateString();
    const totalWins = stats.winsInitial + stats.winsGale1 + stats.winsGale2;
    const totalBets = totalWins + stats.losses;
    const winRate = totalBets > 0 ? (totalWins / totalBets * 100).toFixed(2) : 0;

    const report = `
📊 **Relatório Diário - ${new Date().toLocaleDateString('pt-BR')}**
- Vitórias (Aposta Inicial): ${stats.winsInitial}
- Vitórias (Gale 1): ${stats.winsGale1}
- Vitórias (Gale 2): ${stats.winsGale2}
- Perdas: ${stats.losses}
- Total de Vitórias: ${totalWins}
- Taxa de Acerto: ${winRate}%
Curtiu os sinais? Vamos lucrar juntos 🔥🔥🚀🚀
    `;

    try {
        // Envia o relatório e obtém o message_id
        const sentMessage = await bot.sendMessage(CHANNEL_ID, report);
        const messageId = sentMessage.message_id;

        // Fixa a mensagem (sem notificação)
        await bot.pinChatMessage(CHANNEL_ID, messageId, { disable_notification: true });
        logger.info(`Relatório diário enviado e fixado. Message ID: ${messageId}`);

        // Reseta os contadores após o envio do relatório, se o dia mudou
        if (currentDate !== lastResetDate) {
            stats = { winsInitial: 0, winsGale1: 0, winsGale2: 0, losses: 0 };
            lastResetDate = currentDate;
            saveStats({ ...stats, lastResetDate, weeklyStats });
        }
    } catch (error) {
        logger.error(`Erro ao enviar ou fixar o relatório diário: ${error.message}`);
    }
}

// Função para enviar o relatório semanal
async function sendWeeklyReport(bot) {
    const now = new Date();
    const startDate = new Date(weeklyStats.startDate);
    const daysSinceStart = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));

    // Se já passou uma semana (7 dias), envia o relatório e reseta os contadores semanais
    if (daysSinceStart >= 7) {
        const totalWins = weeklyStats.wins;
        const totalBets = totalWins + weeklyStats.losses;
        const winRate = totalBets > 0 ? (totalWins / totalBets * 100).toFixed(2) : 0;
        const initialWinRate = weeklyStats.initialWins > 0 ? (weeklyStats.initialWins / totalBets * 100).toFixed(2) : 0;

        const report = `
📅 **Relatório Semanal - ${startDate.toLocaleDateString('pt-BR')} a ${now.toLocaleDateString('pt-BR')}**
- Total de Vitórias: ${totalWins}
- Total de Perdas: ${weeklyStats.losses}
- Taxa de Acerto Geral: ${winRate}%
- Taxa de Acerto (Apostas Iniciais): ${initialWinRate}%
Curtiu os resultados? Vamos lucrar ainda mais na próxima semana! 🔥🔥🚀🚀
        `;

        try {
            await bot.sendMessage(CHANNEL_ID, report);
            logger.info('Relatório semanal enviado com sucesso.');

            // Reseta os contadores semanais
            weeklyStats = { wins: 0, losses: 0, initialWins: 0, startDate: now.toISOString() };
            saveStats({ ...stats, lastResetDate, weeklyStats });
        } catch (error) {
            logger.error(`Erro ao enviar o relatório semanal: ${error.message}`);
        }
    }
}

// Loop principal
async function mainLoop() {
    const bot = new TelegramBot(TELEGRAM_TOKEN);
    let sessionId = null;
    let lastSessionRefresh = 0;
    let history = [];
    let patterns = null;
    let galeLevel = 0;
    const maxGale = 2;
    let currentBet = null;
    let lastGameId = null; // Armazena o último gameId processado
    let lastSignal = null; // Armazena o último sinal enviado
    let lastPredictedColor = null; // Armazena a última cor prevista
    let galeMessageSent = false; // Flag para evitar duplicação de mensagens de gale
    let isSystemOperational = false; // Flag para indicar se o sistema está enviando sinais

    // Agendamento do relatório diário às 18:30 (horário local)
    schedule.scheduleJob('30 18 * * *', () => {
        sendDailyReport(bot);
    });

    // Agendamento do relatório semanal às 18:30 de segunda-feira
    schedule.scheduleJob('30 18 * * 1', () => {
        sendWeeklyReport(bot);
    });

    while (true) {
        try {
            const currentTime = performance.now();
            // Só atualiza o JSESSIONID se ainda não existir ou se o acesso ao histórico falhar
            if (!sessionId || (currentTime - lastSessionRefresh >= SESSION_REFRESH_INTERVAL)) {
                logger.info("Obtendo ou atualizando JSESSIONID...");
                sessionId = await getJSessionId();
                lastSessionRefresh = currentTime;
                if (!sessionId) {
                    logger.error("Falha ao obter JSESSIONID.");
                    if (!isSystemInErrorState) {
                        await sendSystemStatus(bot, "Alerta: Sistema analisando novas oportunidades. Por favor aguarde ...");
                        isSystemInErrorState = true;
                        isSystemOperational = false;
                    }
                    await delay(30000);
                    continue;
                }
            }

            const gameData = await fetchGameHistory(sessionId);
            if (!gameData || !gameData.megaSicBacGameStatisticHistory) {
                logger.warn("Falha ao acessar histórico de jogos com o JSESSIONID atual. Tentando renovar...");
                sessionId = await getJSessionId(); // Tenta renovar o JSESSIONID
                if (!sessionId) {
                    logger.error("Falha ao renovar JSESSIONID.");
                    if (!isSystemInErrorState) {
                        await sendSystemStatus(bot, "Alerta: Sistema analisando novas oportunidades. Por favor aguarde ...");
                        isSystemInErrorState = true;
                        isSystemOperational = false;
                    }
                    await delay(30000);
                    continue;
                }
                // Tenta novamente com o novo sessionId
                const newGameData = await fetchGameHistory(sessionId);
                if (!newGameData || !newGameData.megaSicBacGameStatisticHistory) {
                    logger.error("Falha ao acessar histórico mesmo com novo JSESSIONID.");
                    if (!isSystemInErrorState) {
                        await sendSystemStatus(bot, "Alerta: Sistema analisando novas oportunidades. Por favor aguarde ...");
                        isSystemInErrorState = true;
                        isSystemOperational = false;
                    }
                    await delay(30000);
                    continue;
                }
                gameData = newGameData; // Atualiza gameData com o sucesso
            }

            const newHistory = gameData.megaSicBacGameStatisticHistory;
            if (!newHistory.length) {
                logger.warning("Histórico vazio. Tentando novamente em 10 segundos...");
                await delay(10000);
                continue;
            }

            const latestGame = newHistory[0];
            const latestGameId = latestGame.gameId;

            if (lastGameId === null) {
                // Primeira iteração: inicializa o último gameId
                lastGameId = latestGameId;
                history = newHistory;
                patterns = buildPatterns(history);
            } else if (latestGameId !== lastGameId) {
                // Nova jogada detectada
                logger.info(`Nova jogada detectada: gameId ${latestGameId}`);
                galeMessageSent = false; // Reseta a flag no início de uma nova jogada

                // Verifica o resultado da aposta anterior (se houver)
                if (currentBet) {
                    const result = latestGame.result;
                    if (result === currentBet || result === "TIE") {
                        if (result === "TIE") {
                            await sendSignalDefault(bot, "✅ GANHAMOS em TIE!");
                        } else {
                            await sendSignalDefault(bot, `✅ GANHAMOS em ${currentBet}!`);
                        }
                        if (galeLevel === 0) {
                            stats.winsInitial++;
                            weeklyStats.initialWins++;
                        } else if (galeLevel === 1) stats.winsGale1++;
                        else if (galeLevel === 2) stats.winsGale2++;
                        weeklyStats.wins++;
                        logger.info(`Vitória registrada: Initial=${stats.winsInitial}, Gale1=${stats.winsGale1}, Gale2=${stats.winsGale2}`);
                        saveStats({ ...stats, lastResetDate, weeklyStats }); // Salva os contadores após cada vitória
                        galeLevel = 0;
                        currentBet = null;
                        lastSignal = null;
                    } else {
                        galeLevel++;
                        if (galeLevel > maxGale) {
                            await sendSignalDefault(bot, `❌ PERDEMOS após ${maxGale} gales. Padrão quebrado, segue o game e aguardando novo padrão...`);
                            stats.losses++;
                            weeklyStats.losses++;
                            logger.info(`Perda registrada: Losses=${stats.losses}`);
                            saveStats({ ...stats, lastResetDate, weeklyStats }); // Salva os contadores após cada perda
                            galeLevel = 0;
                            currentBet = null;
                            lastSignal = null;
                        }
                        // Não envia mensagem de gale aqui; será tratado no loop de padrões
                    }
                }

                // Atualiza o histórico e os padrões
                history = newHistory;
                patterns = buildPatterns(history);
                lastGameId = latestGameId;

                // Verifica padrões para diferentes tamanhos de sequência
                let newSignalDetected = false;
                for (let seqLength = 4; seqLength <= 9; seqLength++) {
                    if (history.length < seqLength) continue;

                    // Inverte a sequência para que seja do mais antigo ao mais recente
                    const currentSequence = history.slice(0, seqLength).reverse().map(game => game.result);
                    const [predictedColor, confidence, occurrences, detectedSequence] = predictNext(currentSequence, patterns);

                    if (predictedColor && galeLevel <= maxGale) {
                        currentBet = predictedColor;
                        lastPredictedColor = predictedColor;
                        // Ajuste para incluir "Gale 1" e "Gale 2" com proteção no TIE
                        let signal;
                        if (galeLevel === 1) {
                            signal = `🚨 Padrão detectado: ${detectedSequence.join(', ')}\nAPOSTE ${currentBet} (Gale 1 com proteção no TIE)\nConfiança: ${(confidence * 100).toFixed(2)}%`;
                        } else if (galeLevel === 2) {
                            signal = `🚨 Padrão detectado: ${detectedSequence.join(', ')}\nAPOSTE ${currentBet} (Gale 2 com proteção no TIE)\nConfiança: ${(confidence * 100).toFixed(2)}%`;
                        } else {
                            signal = `🚨 Padrão detectado: ${detectedSequence.join(', ')}\nAPOSTE ${currentBet} (Aposta Inicial com proteção no TIE)\nConfiança: ${(confidence * 100).toFixed(2)}%`;
                        }

                        await sendSignalDefault(bot, signal);
                        lastSignal = signal;
                        newSignalDetected = true;
                        galeMessageSent = true; // Marca que um sinal foi enviado
                        if (!isSystemOperational) {
                            // await sendSystemStatus(bot, "Sistema voltou ao normal. Sinais retomados.");
                            isSystemInErrorState = false;
                            isSystemOperational = true;
                        }
                        break;
                    }
                }

                // Se não houver novo sinal detectado, mas ainda estamos em um ciclo de Gale
                if (!newSignalDetected && galeLevel > 0 && !galeMessageSent) {
                    const galeMessage = `Realizar Gale ${galeLevel} na cor ${currentBet}`;
                    await sendSignalDefault(bot, galeMessage);
                    logger.info(`Enviada mensagem de Gale (sem novo padrão): ${galeMessage}`);
                    galeMessageSent = true;
                    if (!isSystemOperational) {
                        await sendSystemStatus(bot, "Sistema voltou ao normal. Sinais retomados.");
                        isSystemInErrorState = false;
                        isSystemOperational = true;
                    }
                }
            } else {
                // Nenhuma nova jogada; aguarda antes de verificar novamente
                logger.info(`Nenhuma nova jogada. Último gameId: ${lastGameId}`);
                await delay(5000);
            }
        } catch (error) {
            logger.error(`Erro no sistema: ${error.message}. Tentando novamente em 30 segundos...`);
            logger.error(`Stack trace: ${error.stack}`);
            if (!isSystemInErrorState) {
                // await sendSystemStatus(bot, "Alerta: Sistema analisando novas oportunidades. Por favor aguarde ...");
                isSystemInErrorState = true;
                isSystemOperational = false;
            }
            await delay(30000);
        }
    }
}

// Iniciar o sistema com tratamento de interrupção
(async () => {
    try {
        await mainLoop();
    } catch (error) {
        logger.error(`Erro fatal: ${error.message}`);
        logger.error(`Stack trace: ${error.stack}`);
        await killChromeProcesses();
        process.exit(1);
    }
})();

// Tratamento de interrupção (equivalente ao KeyboardInterrupt do Python)
process.on('SIGINT', async () => {
    logger.info("Script interrompido pelo usuário. Encerrando processos pendentes...");
    await killChromeProcesses();
    process.exit(0);
});