const { chromium } = require('playwright');
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { exec } = require('child_process');
const schedule = require('node-schedule');
const fs = require('fs');

// Configurações básicas
const TELEGRAM_TOKEN = "7353153409:AAFCy1qUjxzZSgT_XUoOScR1Rjl4URtfzk8";
const CHANNEL_ID = "-1002357054147";
const INITIAL_URLS = [
    "https://www.seguro.bet.br",
    "https://www.seguro.bet.br/cassino/slots/all?btag=2329948",
];
const GAME_URL = "https://www.seguro.bet.br/cassino/slots/320/320/pragmatic-play-live/56977-420031975-treasure-island";
const JSON_URL = "https://games.pragmaticplaylive.net/api/ui/stats?JSESSIONID={}&tableId=a10megasicbaca10&noOfGames=500";
const ERROR_MESSAGE_COOLDOWN = 300 * 1000; // 5 minutos
const JSESSIONID_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutos

// Configuração de logging
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} - ${level.toUpperCase()} - ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'signal_system.log' }),
        new winston.transports.Console()
    ]
});

// Controle de mensagens de erro
const lastErrorMessageTime = {};
let isSystemInErrorState = false;

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

// Função para matar processos Chrome pendentes
async function killChromeProcesses() {
    try {
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
    await killChromeProcesses();

    let browser = null;
    let page = null;
    const maxAttempts = 3;
    let attempt = 0;

    while (attempt < maxAttempts) {
        try {
            logger.info(`Tentativa ${attempt + 1}/${maxAttempts} para inicializar o navegador...`);
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
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
        const enterSelectors = [
            'button.v3-btn:nth-child(1)',
            'button.v3-btn',
            'xpath=/html/body/div[2]/div[1]/div/div[2]/header/div[2]/div/div/div/div/div[3]/div/div/div/div/div/button[1]',
            'button:has-text("Entrar")'
        ];

        let enterButton = null;
        let currentUrl = null;

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
                enterButton = await waitForElement(page, enterSelectors, 10000);
                currentUrl = url;
                break;
            } catch (error) {
                logger.warn(`Botão 'Entrar' não encontrado em ${url}: ${error.message}`);
            }
        }

        if (!enterButton) {
            logger.error(`Botão 'Entrar' não encontrado em nenhuma das URLs: ${INITIAL_URLS.join(', ')}`);
            throw new Error("Botão 'Entrar' não encontrado.");
        }

        logger.info(`Botão 'Entrar' encontrado com sucesso em ${currentUrl}!`);

        logger.info("Tentando aceitar os cookies...");
        const cookieSelectors = [
            '#btn-sim',
            'xpath=/html/body/div[5]/div/button[2]',
            'button:has-text("Aceitar")'
        ];
        const cookieButton = await waitForElement(page, cookieSelectors, 30000);
        await cookieButton.click();
        logger.info("Cookies aceitos!");

        await delay(3000);

        logger.info("Tentando clicar no botão 'Entrar'...");
        await enterButton.click();
        logger.info("Botão 'Entrar' clicado!");

        await delay(5000);

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
        await usernameInput.fill('renanokada2000@gmail.com');
        logger.info("Usuário preenchido!");

        await delay(2000);

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
        await passwordInput.fill('Fabiodinha@2014');
        logger.info("Senha preenchida!");

        await delay(2000);

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

        logger.info(`Acessando ${GAME_URL}...`);
        await page.goto(GAME_URL, { waitUntil: 'networkidle', timeout: 90000 });
        logger.info(`URL atual após navegação para jogo: ${page.url()}`);

        let sessionId = null;
        let isSessionIdCaptured = false;

        page.on('requestfinished', async (request) => {
            if (isSessionIdCaptured) return;

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

        const maxWaitTime = 30000;
        const startTime = Date.now();
        while (!sessionId && (Date.now() - startTime) < maxWaitTime) {
            await delay(100);
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
function predictNext(sequence, patterns, minConfidence = 0.75, minOccurrences = 4) {
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
        const sentMessage = await bot.sendMessage(CHANNEL_ID, report);
        const messageId = sentMessage.message_id;
        await bot.pinChatMessage(CHANNEL_ID, messageId, { disable_notification: true });
        logger.info(`Relatório diário enviado e fixado. Message ID: ${messageId}`);

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
    let sessionId = null; // JSESSIONID atual usado pelo loop principal
    let newSessionId = null; // Novo JSESSIONID sendo obtido em segundo plano
    let history = [];
    let patterns = null;
    let galeLevel = 0;
    const maxGale = 2;
    let lastGameId = null;
    let isSystemOperational = false;
    let isUpdatingJSessionId = false; // Flag para controlar a execução de updateJSessionId
    let activeSignal = null; // Armazena o sinal ativo (cor, nível de Gale, gameId)

    // Função para atualizar o JSESSIONID
    const updateJSessionId = async () => {
        if (isUpdatingJSessionId) {
            logger.info("Atualização do JSESSIONID já em andamento. Aguardando conclusão...");
            return;
        }

        isUpdatingJSessionId = true;
        try {
            logger.info("Iniciando atualização do JSESSIONID...");
            const updatedSessionId = await getJSessionId();
            if (updatedSessionId) {
                newSessionId = updatedSessionId;
                logger.info(`Novo JSESSIONID obtido com sucesso: ${newSessionId}`);
            } else {
                logger.warn("Falha ao obter novo JSESSIONID. Mantendo o atual.");
            }
        } catch (error) {
            logger.error(`Erro ao atualizar JSESSIONID: ${error.message}`);
        } finally {
            isUpdatingJSessionId = false;
        }
    };

    // Loop para atualizar o JSESSIONID a cada 5 minutos após o término do anterior
    const updateJSessionIdLoop = async () => {
        while (true) {
            await updateJSessionId();
            logger.info(`Aguardando ${JSESSIONID_UPDATE_INTERVAL / 1000} segundos antes da próxima atualização do JSESSIONID...`);
            await delay(JSESSIONID_UPDATE_INTERVAL);
        }
    };

    // Inicializa o JSESSIONID antes de começar o loop principal
    sessionId = await getJSessionId();
    if (!sessionId) {
        logger.error("Não foi possível obter o JSESSIONID inicial. Encerrando...");
        process.exit(1);
    }

    // Inicia o loop de atualização do JSESSIONID em segundo plano
    updateJSessionIdLoop().catch(error => {
        logger.error(`Erro fatal no loop de atualização do JSESSIONID: ${error.message}`);
        process.exit(1);
    });

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
            // Se houver um novo JSESSIONID disponível, substitua o atual
            if (newSessionId && newSessionId !== sessionId) {
                logger.info(`Atualizando JSESSIONID: ${sessionId} -> ${newSessionId}`);
                sessionId = newSessionId;
                newSessionId = null; // Limpa o novo ID após usá-lo
            }

            // Se não houver JSESSIONID, aguarde até que um novo seja obtido
            if (!sessionId) {
                logger.warn("Nenhum JSESSIONID disponível. Aguardando nova tentativa de atualização...");
                if (!isSystemInErrorState) {
                    await sendSystemStatus(bot, "Alerta: Sistema analisando novas oportunidades. Por favor aguarde ...");
                    isSystemInErrorState = true;
                    isSystemOperational = false;
                }
                await delay(30000);
                continue;
            }

            const gameData = await fetchGameHistory(sessionId);
            if (!gameData || !gameData.megaSicBacGameStatisticHistory) {
                logger.warn("Falha ao acessar histórico de jogos com o JSESSIONID atual.");
                // Tenta usar o novo JSESSIONID, se disponível
                if (newSessionId) {
                    logger.info(`Tentando novo JSESSIONID: ${newSessionId}`);
                    sessionId = newSessionId;
                    newSessionId = null;
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
                    gameData = newGameData;
                } else {
                    logger.warn("Nenhum novo JSESSIONID disponível. Aguardando próxima atualização...");
                    if (!isSystemInErrorState) {
                        await sendSystemStatus(bot, "Alerta: Sistema analisando novas oportunidades. Por favor aguarde ...");
                        isSystemInErrorState = true;
                        isSystemOperational = false;
                    }
                    await delay(30000);
                    continue;
                }
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
                lastGameId = latestGameId;
                history = newHistory;
                patterns = buildPatterns(history);
            } else if (latestGameId !== lastGameId) {
                logger.info(`Nova jogada detectada: gameId ${latestGameId}`);

                // Atualiza o histórico e os padrões
                history = newHistory;
                patterns = buildPatterns(history);
                lastGameId = latestGameId;

                // Verifica o resultado do sinal ativo, se houver
                if (activeSignal) {
                    const result = latestGame.result;
                    if (result === activeSignal.bet || result === "TIE") {
                        // Vitória ou TIE
                        if (result === "TIE") {
                            await sendSignalDefault(bot, "✅ GANHAMOS em TIE!");
                        } else {
                            await sendSignalDefault(bot, `✅ GANHAMOS em ${activeSignal.bet}!`);
                        }
                        if (galeLevel === 0) {
                            stats.winsInitial++;
                            weeklyStats.initialWins++;
                        } else if (galeLevel === 1) stats.winsGale1++;
                        else if (galeLevel === 2) stats.winsGale2++;
                        weeklyStats.wins++;
                        logger.info(`Vitória registrada: Initial=${stats.winsInitial}, Gale1=${stats.winsGale1}, Gale2=${stats.winsGale2}`);
                        saveStats({ ...stats, lastResetDate, weeklyStats });
                        galeLevel = 0;
                        activeSignal = null;
                    } else {
                        // Perda (Red)
                        galeLevel++;
                        if (galeLevel > maxGale) {
                            await sendSignalDefault(bot, `❌ PERDEMOS após ${maxGale} gales. Padrão quebrado, segue o game e aguardando novo padrão...`);
                            stats.losses++;
                            weeklyStats.losses++;
                            logger.info(`Perda registrada: Losses=${stats.losses}`);
                            saveStats({ ...stats, lastResetDate, weeklyStats });
                            galeLevel = 0;
                            activeSignal = null;
                        } else {
                            // Não envia sinal de Gale imediatamente; aguarda um novo padrão
                            activeSignal = null; // Limpa o sinal ativo para aguardar um novo padrão
                        }
                    }
                }

                // Se não houver sinal ativo, procura um novo padrão
                if (!activeSignal) {
                    let newSignalDetected = false;
                    for (let seqLength = 4; seqLength <= 9; seqLength++) {
                        if (history.length < seqLength) continue;

                        const currentSequence = history.slice(0, seqLength).reverse().map(game => game.result);
                        const [predictedColor, confidence, occurrences, detectedSequence] = predictNext(currentSequence, patterns);

                        if (predictedColor && galeLevel <= maxGale) {
                            let signal;
                            if (galeLevel === 1) {
                                signal = `🚨 Padrão detectado: ${detectedSequence.join(', ')}\nAPOSTE ${predictedColor} (Gale 1 com proteção no TIE)\nConfiança: ${(confidence * 100).toFixed(2)}%`;
                            } else if (galeLevel === 2) {
                                signal = `🚨 Padrão detectado: ${detectedSequence.join(', ')}\nAPOSTE ${predictedColor} (Gale 2 com proteção no TIE)\nConfiança: ${(confidence * 100).toFixed(2)}%`;
                            } else {
                                signal = `🚨 Padrão detectado: ${detectedSequence.join(', ')}\nAPOSTE ${predictedColor} (Aposta Inicial com proteção no TIE)\nConfiança: ${(confidence * 100).toFixed(2)}%`;
                            }

                            await sendSignalDefault(bot, signal);
                            activeSignal = {
                                bet: predictedColor,
                                galeLevel: galeLevel,
                                gameId: latestGameId
                            };
                            newSignalDetected = true;
                            if (!isSystemOperational) {
                                isSystemInErrorState = false;
                                isSystemOperational = true;
                            }
                            break;
                        }
                    }

                    if (!newSignalDetected) {
                        logger.info("Nenhum padrão detectado. Aguardando próximo jogo...");
                    }
                }
            } else {
                logger.info(`Nenhuma nova jogada. Último gameId: ${lastGameId}`);
                await delay(5000);
            }
        } catch (error) {
            logger.error(`Erro no sistema: ${error.message}. Tentando novamente em 30 segundos...`);
            logger.error(`Stack trace: ${error.stack}`);
            if (!isSystemInErrorState) {
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

// Tratamento de interrupção
process.on('SIGINT', async () => {
    logger.info("Script interrompido pelo usuário. Encerrando processos pendentes...");
    await killChromeProcesses();
    process.exit(0);
});