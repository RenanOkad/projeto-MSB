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
const CHANNEL_ID = "-1002357054147"; // Canal VIP
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
        losses: 0,
        lastResetDate: new Date().toDateString(),
        weeklyStats: { wins: 0, losses: 0, initialWins: 0, startDate: new Date().toISOString() }
    };
}

//Função para salvar os contadores no arquivo
function saveStats(stats) {
    try {
        fs.writeFileSync('stats.json', JSON.stringify(stats, null, 2));
        logger.info('Contadores salvos em stats.json');
    } catch (error) {
        logger.error(`Erro ao salvar stats.json: ${error.message}`);
    }
}

// Função para carregar ou inicializar o arquivo de horários vitoriosos
function loadWinTimes() {
    try {
        if (fs.existsSync('win_times.json')) {
            const data = fs.readFileSync('win_times.json', 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        logger.error(`Erro ao carregar win_times.json: ${error.message}`);
    }
    return {};
}

// Função para salvar o arquivo de horários vitoriosos
function saveWinTimes(winTimes) {
    try {
        fs.writeFileSync('win_times.json', JSON.stringify(winTimes, null, 2));
        logger.info('Horários vitoriosos salvos em win_times.json');
    } catch (error) {
        logger.error(`Erro ao salvar win_times.json: ${error.message}`);
    }
}

// Função para carregar ou inicializar o arquivo de top sequências
function loadTopSequences() {
    try {
        if (fs.existsSync('top_sequences.json')) {
            const data = fs.readFileSync('top_sequences.json', 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        logger.error(`Erro ao carregar top_sequences.json: ${error.message}`);
    }
    return {};
}

// Função para salvar o arquivo de top sequências
function saveTopSequences(topSequences) {
    try {
        fs.writeFileSync('top_sequences.json', JSON.stringify(topSequences, null, 2));
        logger.info('Top sequências salvos em top_sequences.json');
    } catch (error) {
        logger.error(`Erro ao salvar top_sequences.json: ${error.message}`);
    }
}

// Carrega os contadores na inicialização
let stats = loadStats();
let lastResetDate = stats.lastResetDate;
let weeklyStats = stats.weeklyStats;
let winTimes = loadWinTimes();
let topSequences = loadTopSequences();

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
            'button:has-text("Aceitar")',
            'div.customModal div.modal__body button.v3-btn.v3-btn-primary.v3-btn-lg.x-button'
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

// Função para construir padrões de cores
function buildColorPatterns(history, minSeq = 4, maxSeq = 9) {
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

// Função para prever o próximo resultado com base em cores
function predictNextColor(sequence, patterns, minConfidence = 0.75, minOccurrences = 5) {
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

// Função para construir padrões de dados
function buildDicePatterns(history, seqLength = 4) {
    const patterns = {};
    for (let i = 0; i < history.length - seqLength; i++) {
        const sequence = history.slice(i, i + seqLength).map(game => [game.p1, game.p2, game.b1, game.b2].join(','));
        const nextResult = history[i + seqLength].result;
        const sequenceKey = sequence.join(';');

        if (!patterns[sequenceKey]) patterns[sequenceKey] = { results: {}, sequence: sequence };
        patterns[sequenceKey].results[nextResult] = (patterns[sequenceKey].results[nextResult] || 0) + 1;
    }
    return patterns;
}

// Função para prever o próximo resultado com base em dados
function predictNextDice(sequence, patterns, minConfidence = 0.75, minOccurrences = 5) {
    const sequenceKey = sequence.join(';');
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

    return confidence >= minConfidence ? [bestResult, confidence, total, detectedSequence] : [null, null, null, null];
}

// Função para construir padrões baseados em eventos (firstDouble, secondDouble, triple)
function buildEventPatterns(history) {
    const patterns = {
        afterFirstDouble: { count: 0, results: {} },
        afterFirstAndSecondDouble: { results: {} },
        afterAlternatingDoubles: { results: {} },
        afterTriple: { results: {} },
        afterTripleXGames: { results: {} }
    };

    let firstDoubleCount = 0;
    let lastEvent = null;
    let triplePositions = [];

    for (let i = 0; i < history.length; i++) {
        const game = history[i];
        const nextResult = i + 1 < history.length ? history[i + 1].result : null;

        // Após X firstDouble (ex.: após 3 firstDouble)
        if (game.firstDouble) {
            firstDoubleCount++;
            if (firstDoubleCount === 3 && nextResult) {
                patterns.afterFirstDouble.results[nextResult] = (patterns.afterFirstDouble.results[nextResult] || 0) + 1;
                firstDoubleCount = 0; // Reseta após atingir o limite
            }
        }

        // Após firstDouble e secondDouble no mesmo jogo
        if (game.firstDouble && game.secondDouble && nextResult) {
            patterns.afterFirstAndSecondDouble.results[nextResult] = (patterns.afterFirstAndSecondDouble.results[nextResult] || 0) + 1;
        }

        // Sequência alternada de firstDouble e secondDouble
        if (game.firstDouble && !game.secondDouble) {
            if (lastEvent === 'secondDouble' && nextResult) {
                patterns.afterAlternatingDoubles.results[nextResult] = (patterns.afterAlternatingDoubles.results[nextResult] || 0) + 1;
            }
            lastEvent = 'firstDouble';
        } else if (game.secondDouble && !game.firstDouble) {
            if (lastEvent === 'firstDouble' && nextResult) {
                patterns.afterAlternatingDoubles.results[nextResult] = (patterns.afterAlternatingDoubles.results[nextResult] || 0) + 1;
            }
            lastEvent = 'secondDouble';
        } else {
            lastEvent = null;
        }

        // Após um triple
        if (game.triple && nextResult) {
            patterns.afterTriple.results[nextResult] = (patterns.afterTriple.results[nextResult] || 0) + 1;
            triplePositions.push(i);
        }
    }

    // Após X jogos de um triple (ex.: 3 jogos após)
    const xGamesAfterTriple = 3;
    for (const pos of triplePositions) {
        const targetPos = pos + xGamesAfterTriple;
        if (targetPos < history.length) {
            const nextResult = history[targetPos].result;
            patterns.afterTripleXGames.results[nextResult] = (patterns.afterTripleXGames.results[nextResult] || 0) + 1;
        }
    }

    return patterns;
}

// Função para prever o próximo resultado com base em eventos
function predictNextEvent(history, eventPatterns, minConfidence = 0.75, minOccurrences = 5) {
    let bestResult = null;
    let confidence = 0;
    let total = 0;
    let patternType = null;

    const latestGame = history[0];

    // Após X firstDouble
    let firstDoubleCount = 0;
    for (let i = 0; i < history.length; i++) {
        if (history[i].firstDouble) firstDoubleCount++;
    }
    if (firstDoubleCount === 3) {
        const resultCounts = eventPatterns.afterFirstDouble.results;
        const totalOccurrences = Object.values(resultCounts).reduce((sum, count) => sum + count, 0);
        if (totalOccurrences >= minOccurrences) {
            const probabilities = {};
            for (const result in resultCounts) {
                probabilities[result] = resultCounts[result] / totalOccurrences;
            }
            const predictedResult = Object.keys(probabilities).reduce((a, b) => probabilities[a] > probabilities[b] ? a : b);
            const predictedConfidence = probabilities[predictedResult];
            if (predictedConfidence >= minConfidence && predictedConfidence > confidence) {
                bestResult = predictedResult;
                confidence = predictedConfidence;
                total = totalOccurrences;
                patternType = "Após 3 First Doubles";
            }
        }
    }

    // Após firstDouble e secondDouble
    if (latestGame.firstDouble && latestGame.secondDouble) {
        const resultCounts = eventPatterns.afterFirstAndSecondDouble.results;
        const totalOccurrences = Object.values(resultCounts).reduce((sum, count) => sum + count, 0);
        if (totalOccurrences >= minOccurrences) {
            const probabilities = {};
            for (const result in resultCounts) {
                probabilities[result] = resultCounts[result] / totalOccurrences;
            }
            const predictedResult = Object.keys(probabilities).reduce((a, b) => probabilities[a] > probabilities[b] ? a : b);
            const predictedConfidence = probabilities[predictedResult];
            if (predictedConfidence >= minConfidence && predictedConfidence > confidence) {
                bestResult = predictedResult;
                confidence = predictedConfidence;
                total = totalOccurrences;
                patternType = "Após First e Second Double";
            }
        }
    }

    // Após sequência alternada de firstDouble e secondDouble
    let lastEvent = null;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].firstDouble && !history[i].secondDouble) {
            lastEvent = 'firstDouble';
            break;
        } else if (history[i].secondDouble && !history[i].firstDouble) {
            lastEvent = 'secondDouble';
            break;
        }
    }
    if ((latestGame.firstDouble && lastEvent === 'secondDouble') || (latestGame.secondDouble && lastEvent === 'firstDouble')) {
        const resultCounts = eventPatterns.afterAlternatingDoubles.results;
        const totalOccurrences = Object.values(resultCounts).reduce((sum, count) => sum + count, 0);
        if (totalOccurrences >= minOccurrences) {
            const probabilities = {};
            for (const result in resultCounts) {
                probabilities[result] = resultCounts[result] / totalOccurrences;
            }
            const predictedResult = Object.keys(probabilities).reduce((a, b) => probabilities[a] > probabilities[b] ? a : b);
            const predictedConfidence = probabilities[predictedResult];
            if (predictedConfidence >= minConfidence && predictedConfidence > confidence) {
                bestResult = predictedResult;
                confidence = predictedConfidence;
                total = totalOccurrences;
                patternType = "Após Sequência Alternada de Doubles";
            }
        }
    }

    // Após um triple
    if (history[1]?.triple) {
        const resultCounts = eventPatterns.afterTriple.results;
        const totalOccurrences = Object.values(resultCounts).reduce((sum, count) => sum + count, 0);
        if (totalOccurrences >= minOccurrences) {
            const probabilities = {};
            for (const result in resultCounts) {
                probabilities[result] = resultCounts[result] / totalOccurrences;
            }
            const predictedResult = Object.keys(probabilities).reduce((a, b) => probabilities[a] > probabilities[b] ? a : b);
            const predictedConfidence = probabilities[predictedResult];
            if (predictedConfidence >= minConfidence && predictedConfidence > confidence) {
                bestResult = predictedResult;
                confidence = predictedConfidence;
                total = totalOccurrences;
                patternType = "Após um Triple";
            }
        }
    }

    // Após X jogos de um triple
    const xGamesAfterTriple = 3;
    for (let i = 0; i < history.length; i++) {
        if (history[i].triple) {
            if (i + xGamesAfterTriple === history.length - 1) {
                const resultCounts = eventPatterns.afterTripleXGames.results;
                const totalOccurrences = Object.values(resultCounts).reduce((sum, count) => sum + count, 0);
                if (totalOccurrences >= minOccurrences) {
                    const probabilities = {};
                    for (const result in resultCounts) {
                        probabilities[result] = resultCounts[result] / totalOccurrences;
                    }
                    const predictedResult = Object.keys(probabilities).reduce((a, b) => probabilities[a] > probabilities[b] ? a : b);
                    const predictedConfidence = probabilities[predictedResult];
                    if (predictedConfidence >= minConfidence && predictedConfidence > confidence) {
                        bestResult = predictedResult;
                        confidence = predictedConfidence;
                        total = totalOccurrences;
                        patternType = `Após ${xGamesAfterTriple} Jogos de um Triple`;
                    }
                }
            }
            break;
        }
    }

    return [bestResult, confidence, total, patternType];
}

// Função para converter resultado em emoji
function resultToEmoji(result) {
    switch (result.toUpperCase()) {
        case 'BANKER': return '🔴';
        case 'PLAYER': return '🔵';
        case 'TIE': return '🟠';
        default: return result;
    }
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
    const totalWins = stats.winsInitial + stats.winsGale1;
    const totalBets = totalWins + stats.losses;
    const winRate = totalBets > 0 ? (totalWins / totalBets * 100).toFixed(2) : 0;

    // Obtém as TOP 3 sequências das últimas 24 horas
    const now = new Date();
    const last24h = new Date(now - 24 * 60 * 60 * 1000);
    const sequencesLast24h = Object.entries(topSequences)
        .filter(([_, data]) => new Date(data.lastSeen) >= last24h)
        .sort(([, a], [, b]) => (b.count || 0) - (a.count || 0))
        .slice(0, 3)
        .map(([seq, data]) => {
            const emojiSeq = data.sequence.map(resultToEmoji).join(', ');
            return `- ${emojiSeq} (Repetiu ${data.count} vez${data.count > 1 ? 'es' : ''})`;
        });

    const report = `
📊 **Relatório Diário - ${new Date().toLocaleDateString('pt-BR')}**
- Vitórias (Aposta Inicial): ${stats.winsInitial}
- Vitórias (Gale 1): ${stats.winsGale1}
- Perdas: ${stats.losses}
- Total de Vitórias: ${totalWins}
- Taxa de Acerto: ${winRate}%
🔝 **TOP 3 Sequências nas últimas 24h:**
${sequencesLast24h.length ? sequencesLast24h.join('\n') : '- Nenhuma sequência destacada.'}
Curtiu os sinais? Vamos lucrar juntos 🔥🔥🚀🚀
    `;

    try {
        const sentMessage = await bot.sendMessage(CHANNEL_ID, report);
        const messageId = sentMessage.message_id;
        await bot.pinChatMessage(CHANNEL_ID, messageId, { disable_notification: true });
        logger.info(`Relatório diário enviado e fixado. Message ID: ${messageId}`);

        if (currentDate !== lastResetDate) {
            stats = { winsInitial: 0, winsGale1: 0, losses: 0 };
            lastResetDate = currentDate;
            saveStats({ ...stats, lastResetDate, weeklyStats });
        }
    } catch (error) {
        logger.error(`Erro ao enviar ou fixar o relatório diário: ${error.message}`);
    }
}

// Função para enviar o relatório semanal com horários vitoriosos
async function sendWeeklyReport(bot) {
    const now = new Date();
    const startDate = new Date(weeklyStats.startDate);
    const daysSinceStart = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));

    if (daysSinceStart >= 7) {
        const totalWins = weeklyStats.wins;
        const totalBets = totalWins + weeklyStats.losses;
        const winRate = totalBets > 0 ? (totalWins / totalBets * 100).toFixed(2) : 0;
        const initialWinRate = weeklyStats.initialWins > 0 ? (weeklyStats.initialWins / totalBets * 100).toFixed(2) : 0;

        // Formata os horários vitoriosos
        const winTimeReport = Object.entries(winTimes)
            .map(([range, data]) => `${range} - ${data.winRate.toFixed(2)}% de taxa de vitória`)
            .join('\n');

        const report = `
📅 **Relatório Semanal - ${startDate.toLocaleDateString('pt-BR')} a ${now.toLocaleDateString('pt-BR')}**
- Total de Vitórias: ${totalWins}
- Total de Perdas: ${weeklyStats.losses}
- Taxa de Acerto Geral: ${winRate}%
- Taxa de Acerto (Apostas Iniciais): ${initialWinRate}%
⏰ **Melhores Horários para Entrar:**
${winTimeReport || '- Nenhum horário destacado.'}
Curtiu os resultados? Vamos lucrar ainda mais na próxima semana! 🔥🔥🚀🚀
        `;

        try {
            await bot.sendMessage(CHANNEL_ID, report);
            logger.info('Relatório semanal enviado com sucesso.');

            // Reseta os horários vitoriosos no domingo à noite
            winTimes = {};
            saveWinTimes(winTimes);

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
    let colorPatterns = null;
    let dicePatterns = null;
    let eventPatterns = null;
    let galeLevel = 0;
    const maxGale = 1; // Limitado a Gale 1
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

    // Agendamento do relatório semanal às 20:00 de domingo
    schedule.scheduleJob('0 20 * * 0', () => {
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
            const currentTime = new Date();

            if (lastGameId === null) {
                lastGameId = latestGameId;
                history = newHistory;
                colorPatterns = buildColorPatterns(history);
                dicePatterns = buildDicePatterns(history);
                eventPatterns = buildEventPatterns(history);
            } else if (latestGameId !== lastGameId) {
                logger.info(`Nova jogada detectada: gameId ${latestGameId}`);

                // Atualiza o histórico e os padrões
                history = newHistory;
                colorPatterns = buildColorPatterns(history);
                dicePatterns = buildDicePatterns(history);
                eventPatterns = buildEventPatterns(history);
                lastGameId = latestGameId;

                // Verifica o resultado do sinal ativo, se houver
                if (activeSignal) {
                    const result = latestGame.result;
                    const timeSlot = `${currentTime.getHours()}:${currentTime.getMinutes().toString().padStart(2, '0')}`;
                    const timeRange = `${Math.floor(currentTime.getHours())}:${Math.floor(currentTime.getMinutes() / 30) * 30}:00 - ${Math.floor(currentTime.getHours())}:${Math.floor(currentTime.getMinutes() / 30) * 30 + 30}:00`;
                    if (result === activeSignal.bet || result === "TIE") {
                        // Vitória ou TIE
                        if (result === "TIE") {
                            await sendSignalDefault(bot, "✅ GANHAMOS em 🟠 TIE!");
                        } else {
                            await sendSignalDefault(bot, `✅ GANHAMOS em ${resultToEmoji(activeSignal.bet)} ${activeSignal.bet}!`);
                        }
                        if (galeLevel === 0) {
                            stats.winsInitial++;
                            weeklyStats.initialWins++;
                            // Atualiza horários vitoriosos
                            if (!winTimes[timeRange]) winTimes[timeRange] = { wins: 0, total: 0, winRate: 0, lastSeen: currentTime.toISOString() };
                            winTimes[timeRange].wins++;
                            winTimes[timeRange].total++;
                            winTimes[timeRange].winRate = (winTimes[timeRange].wins / winTimes[timeRange].total) * 100;
                            winTimes[timeRange].lastSeen = currentTime.toISOString();
                        } else if (galeLevel === 1) {
                            stats.winsGale1++;
                            weeklyStats.wins++;
                            if (!winTimes[timeRange]) winTimes[timeRange] = { wins: 0, total: 0, winRate: 0, lastSeen: currentTime.toISOString() };
                            winTimes[timeRange].wins++;
                            winTimes[timeRange].total++;
                            winTimes[timeRange].winRate = (winTimes[timeRange].wins / winTimes[timeRange].total) * 100;
                            winTimes[timeRange].lastSeen = currentTime.toISOString();
                        }
                        weeklyStats.wins++;
                        logger.info(`Vitória registrada: Initial=${stats.winsInitial}, Gale1=${stats.winsGale1}`);
                        saveStats({ ...stats, lastResetDate, weeklyStats });
                        saveWinTimes(winTimes);
                        galeLevel = 0;
                        activeSignal = null;
                    } else {
                        // Perda (Red)
                        galeLevel++;
                        if (!winTimes[timeRange]) winTimes[timeRange] = { wins: 0, total: 0, winRate: 0, lastSeen: currentTime.toISOString() };
                        winTimes[timeRange].total++;
                        winTimes[timeRange].winRate = (winTimes[timeRange].wins / winTimes[timeRange].total) * 100;
                        winTimes[timeRange].lastSeen = currentTime.toISOString();
                        saveWinTimes(winTimes);

                        if (galeLevel > maxGale) {
                            await sendSignalDefault(bot, `❌ PERDEMOS após ${maxGale} gale${maxGale > 1 ? 's' : ''}. Padrão quebrado, segue o game e aguardando novo padrão...`);
                            stats.losses++;
                            weeklyStats.losses++;
                            logger.info(`Perda registrada: Losses=${stats.losses}`);
                            saveStats({ ...stats, lastResetDate, weeklyStats });
                            galeLevel = 0;
                            activeSignal = null;
                        } else {
                            // Aguarda 2 segundos e verifica se um novo sinal foi detectado
                            await delay(2000);
                            if (!activeSignal) {
                                const nextGale = galeLevel === 1 ? "Gale 1" : "Gale 2";
                                await sendSignalDefault(bot, `⚠️ Sistema analisando nova oportunidade para ${nextGale}...`);
                            }
                            activeSignal = null; // Limpa o sinal ativo para aguardar um novo padrão
                        }
                    }
                }

                // Armazena a sequência atual para análise de top sequences
                const currentSequence = history.slice(0, 9).reverse().map(game => game.result);
                const sequenceKey = currentSequence.join(',');
                if (!topSequences[sequenceKey]) {
                    topSequences[sequenceKey] = {
                        sequence: currentSequence,
                        count: 1,
                        lastSeen: currentTime.toISOString()
                    };
                } else {
                    topSequences[sequenceKey].count++;
                    topSequences[sequenceKey].lastSeen = currentTime.toISOString();
                }
                saveTopSequences(topSequences);

                // Se não houver sinal ativo, procura um novo padrão
                if (!activeSignal) {
                    let newSignalDetected = false;
                    let bestPrediction = null;
                    let bestConfidence = 0;
                    let bestPatternDescription = '';

                    // 1. Padrão de cores
                    for (let seqLength = 4; seqLength <= 9; seqLength++) {
                        if (history.length < seqLength) continue;

                        const currentSequence = history.slice(0, seqLength).reverse().map(game => game.result);
                        const [predictedColor, confidence, occurrences, detectedSequence] = predictNextColor(currentSequence, colorPatterns);

                        if (predictedColor && confidence > bestConfidence && galeLevel <= maxGale) {
                            bestPrediction = predictedColor;
                            bestConfidence = confidence;
                            bestPatternDescription = `Padrão de Cores: ${detectedSequence.map(resultToEmoji).join(', ')}`;
                        }
                    }

                    // 2. Padrão de dados
                    if (history.length >= 4) {
                        const currentDiceSequence = history.slice(0, 4).reverse().map(game => [game.p1, game.p2, game.b1, game.b2].join(','));
                        const [predictedDiceColor, diceConfidence, diceOccurrences, diceSequence] = predictNextDice(currentDiceSequence, dicePatterns);
                        if (predictedDiceColor && diceConfidence > bestConfidence && galeLevel <= maxGale) {
                            bestPrediction = predictedDiceColor;
                            bestConfidence = diceConfidence;
                            bestPatternDescription = `Padrão de Dados: ${diceSequence.join('; ')}`;
                        }
                    }

                    // 3. Padrão de eventos
                    const [eventColor, eventConfidence, eventOccurrences, eventPatternType] = predictNextEvent(history, eventPatterns);
                    if (eventColor && eventConfidence > bestConfidence && galeLevel <= maxGale) {
                        bestPrediction = eventColor;
                        bestConfidence = eventConfidence;
                        bestPatternDescription = eventPatternType;
                    }

                    // Envia o sinal com a melhor previsão
                    if (bestPrediction) {
                        let signal;
                        if (galeLevel === 1) {
                            signal = `🚨 ${bestPatternDescription}\nAPOSTE ${resultToEmoji(bestPrediction)} ${bestPrediction} (Gale 1 com proteção no TIE)\nConfiança: ${(bestConfidence * 100).toFixed(2)}%`;
                        } else {
                            signal = `🚨 ${bestPatternDescription}\nAPOSTE ${resultToEmoji(bestPrediction)} ${bestPrediction} (Aposta Inicial com proteção no TIE)\nConfiança: ${(bestConfidence * 100).toFixed(2)}%`;
                        }

                        if (bestConfidence > 0.90) {
                            signal = `🌟 OPORTUNIDADE COM CONFIANÇA ALTA! ${signal}`;
                        }

                        await sendSignalDefault(bot, signal);
                        activeSignal = {
                            bet: bestPrediction,
                            galeLevel: galeLevel,
                            gameId: latestGameId
                        };
                        newSignalDetected = true;
                        if (!isSystemOperational) {
                            isSystemInErrorState = false;
                            isSystemOperational = true;
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