const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com/stream';
const API_KEY = 'R7nkPfaYEmtCYEgE4kCQQy4WHdkOUOTgyDKHIcvyBP3qVEWCkDIhUuOHYUjhQUG5';
const SECRET_KEY = 'EZBzLuzGFuNaK3xiRt7bcWmkqKdqJdfhwEtP5p9JThemrRj10PD0GvUvNXAxXMa7';
const PERCENT_CHANGE = 0.06; // 7% изменение цены для обнаружения
const STABILITY_DURATION = 5 * 1000; // 30 секунд для стабильности
const MAX_CORRECTION = 0.02; // 2% максимальная коррекция цены во время стабильности
const PROFIT_TARGET = 0.03; // 3% цель по прибыли
const LOSS_THRESHOLD = 0.10; // 10% изменение против позиции для фиксации убытка
const CORRECTION_AFTER_PROFIT = 0.01; // 1% коррекция после достижения прибыли
const LOSS_THRESHOLD_FOR_RECOVERY = 0.05; // 5% порог убытка для отслеживания возврата к точке входа


let accountBalance = 0;
let priceHistory = {}; // Хранит историю цен для каждого символа
let openPositions = {}; // Хранит открытые позиции для каждого символа
let potentialEntries = {}; // Хранит символы, ожидающие стабильности после изменения
let priceUpdates = {}; // Хранит последние обновления цен из WebSocket

const logFile = path.join(__dirname, 'trade.log');

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
    console.log(message);
}

function signQuery(params) {
    const query = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    return `${query}&signature=${signature}`;
}

async function getSymbolInfo(symbol) {
    try {
        const response = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
        const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
        if (!symbolInfo) throw new Error(`Symbol ${symbol} not found`);
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        return {
            minQty: parseFloat(lotSizeFilter.minQty),
            stepSize: parseFloat(lotSizeFilter.stepSize),
            minNotional: parseFloat(minNotionalFilter.notional)
        };
    } catch (error) {
        log(`Error fetching symbol info for ${symbol}: ${error.message}`);
        throw error;
    }
}

function roundStepSize(quantity, stepSize) {
    const precision = Math.round(-Math.log10(stepSize));
    const qty = Math.floor(quantity / stepSize) * stepSize;
    return parseFloat(qty.toFixed(precision));
}

async function getAccountBalance() {
    log('Fetching account balance');
    const params = {
        timestamp: Date.now(),
        recvWindow: 5000
    };
    const query = signQuery(params);

    try {
        const response = await axios.get(`${BASE_URL}/fapi/v2/account?${query}`, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        const usdtBalance = response.data.assets.find(asset => asset.asset === 'USDT');
        accountBalance = usdtBalance ? parseFloat(usdtBalance.walletBalance) : 0;
        log(`Account balance: ${usdtBalance.walletBalance}, Available for trade: ${accountBalance / 10}`);
    } catch (error) {
        log(`Error fetching account balance: ${error.response ? error.response.data.msg : error.message}`);
    }
}

async function getSymbolList() {
    log('Fetching symbol list');
    try {
        const response = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
        const symbols = response.data.symbols
            .filter(symbol => symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING')
            .map(symbol => symbol.symbol);
        log(`Symbol list loaded: ${symbols.length} symbols`);
        return symbols;
    } catch (error) {
        log(`Error fetching symbol list: ${error.message}`);
        return [];
    }
}

async function openPosition(symbol, side) {
    log(`Attempting to open position for ${symbol} с направлением ${side}`);
    if (accountBalance === 0) {
        log(`Недостаточно средств для открытия позиции по ${symbol}`);
        return;
    }

    let orderValue = Math.max(accountBalance / 10, 100);
    const { minQty, stepSize } = await getSymbolInfo(symbol);
    const price = priceUpdates[symbol];
    if (!price) {
        log(`Нет текущей цены для ${symbol}`);
        return;
    }

    let minQuantity = 100 / price;
    minQuantity = Math.ceil(minQuantity / stepSize) * stepSize;
    minQuantity = Math.max(minQuantity, minQty);

    let quantity = orderValue / price;
    quantity = roundStepSize(quantity, stepSize);

    if (quantity < minQuantity) {
        quantity = minQuantity;
        orderValue = quantity * price;
    }

    let notional = quantity * price;

    if (orderValue > accountBalance) {
        log(`Недостаточно средств для открытия позиции по ${symbol}. Требуется: ${orderValue.toFixed(2)} USDT, Доступно: ${accountBalance.toFixed(2)} USDT`);
        return;
    }

    log(`Открываем позицию по ${symbol}: Количество ${quantity}, Сумма ${notional.toFixed(2)} USDT`);

    const params = {
        symbol,
        side,
        type: 'MARKET',
        quantity,
        recvWindow: 5000,
        timestamp: Date.now()
    };
    const query = signQuery(params);

    try {
        const response = await axios.post(`${BASE_URL}/fapi/v1/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        log(`Позиция открыта по ${symbol}: Направление ${side}, Количество ${quantity}, Цена входа ${price}`);
        openPositions[symbol] = {
            side,
            entryPrice: price,
            quantity,
            openTime: Date.now(),
            profitTargetReached: false,
            lossThresholdReached: false, // Новое свойство
            peakPrice: price
        };
        accountBalance -= orderValue;
    } catch (error) {
        log(`Ошибка при открытии позиции по ${symbol}: ${error.response ? error.response.data.msg : error.message}`);
    }
}

async function closePosition(symbol) {
    log(`Пытаемся закрыть позицию по ${symbol}`);
    const position = openPositions[symbol];
    if (!position) {
        log(`Нет открытой позиции по ${symbol}`);
        return;
    }

    const oppositeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const quantity = position.quantity;
    const params = {
        symbol,
        side: oppositeSide,
        type: 'MARKET',
        quantity,
        recvWindow: 5000,
        timestamp: Date.now()
    };
    const query = signQuery(params);

    try {
        const response = await axios.post(`${BASE_URL}/fapi/v1/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        log(`Позиция закрыта по ${symbol}`);
        delete openPositions[symbol];
    } catch (error) {
        log(`Ошибка при закрытии позиции по ${symbol}: ${error.response ? error.response.data.msg : error.message}`);
    }
}

function handlePriceUpdate(data) {
    const symbol = data.s;
    const currentPrice = parseFloat(data.c);
    const currentTime = Date.now();

    if (!symbol || !currentPrice) return;

    if (!priceHistory[symbol]) {
        priceHistory[symbol] = [];
    }

    // Обновляем историю цен (используем для коррекции)
    priceHistory[symbol].push({ time: currentTime, price: currentPrice });
    // Удаляем записи старше STABILITY_DURATION
    priceHistory[symbol] = priceHistory[symbol].filter(entry => currentTime - entry.time <= STABILITY_DURATION);

    // Обновляем последнюю цену
    priceUpdates[symbol] = currentPrice;

    // Обработка потенциальных входов
    if (potentialEntries[symbol]) {
        const entry = potentialEntries[symbol];
        const percentChangeDuringStability = (currentPrice - entry.startPrice) / entry.startPrice;

        // Проверяем коррекцию
        const correction = Math.abs(percentChangeDuringStability - entry.percentChange);
        if (correction <= MAX_CORRECTION) {
            // Проверяем, прошло ли время стабильности
            if (currentTime - entry.startTime >= STABILITY_DURATION) {
                const direction = entry.percentChange > 0 ? 'BUY' : 'SELL';
                log(`Подтверждено стабильное изменение цены для ${symbol}: ${(entry.percentChange * 100).toFixed(2)}% за ${(STABILITY_DURATION / 1000)} секунд. Открываем позицию ${direction}.`);
                openPosition(symbol, direction);
                delete potentialEntries[symbol];
            }
        } else {
            // Коррекция превышена, сбрасываем
            log(`Коррекция цены превышена для ${symbol}. Сбрасываем таймер стабильности.`);
            delete potentialEntries[symbol];
        }
    } else {
        // Проверяем изменение цены на PERCENT_CHANGE или более
        const oldPriceEntry = priceHistory[symbol][0];
        if (oldPriceEntry) {
            const percentChange = (currentPrice - oldPriceEntry.price) / oldPriceEntry.price;
            if (Math.abs(percentChange) >= PERCENT_CHANGE) {
                // Начинаем отсчет стабильности
                potentialEntries[symbol] = {
                    startTime: currentTime,
                    startPrice: currentPrice,
                    percentChange
                };
                log(`Обнаружено изменение цены для ${symbol}: ${(percentChange * 100).toFixed(2)}%. Запускаем таймер стабильности.`);
            }
        }
    }

    // Обработка открытых позиций
    if (openPositions[symbol]) {
        const position = openPositions[symbol];
        const entryPrice = position.entryPrice;
        const positionChange = (currentPrice - entryPrice) / entryPrice;

        // Проверяем движение цены в направлении позиции
        const isProfitable = (position.side === 'BUY' && positionChange > 0) || (position.side === 'SELL' && positionChange < 0);

        // Обновляем peakPrice, если цена движется в нашу пользу
        if (isProfitable) {
            if (!position.peakPrice || (position.side === 'BUY' && currentPrice > position.peakPrice) || (position.side === 'SELL' && currentPrice < position.peakPrice)) {
                position.peakPrice = currentPrice;
            }
        }

        // Проверяем, достигла ли цена убытка более 5% после входа в позицию
        const isLosing = (position.side === 'BUY' && positionChange < 0) || (position.side === 'SELL' && positionChange > 0);
        if (isLosing && Math.abs(positionChange) >= LOSS_THRESHOLD_FOR_RECOVERY && !position.lossThresholdReached) {
            position.lossThresholdReached = true;
            log(`Порог убытка в ${(LOSS_THRESHOLD_FOR_RECOVERY * 100).toFixed(2)}% достигнут для ${symbol}. Отслеживаем возврат к точке входа.`);
        }

        // Если порог убытка достигнут и цена вернулась к точке входа, закрываем позицию
        if (position.lossThresholdReached && !position.profitTargetReached) {
            const isBackToEntry = (position.side === 'BUY' && currentPrice >= entryPrice) || (position.side === 'SELL' && currentPrice <= entryPrice);
            if (isBackToEntry) {
                log(`Цена вернулась к точке входа после убытка для ${symbol}. Закрываем позицию.`);
                closePosition(symbol);
                return; // Прекращаем дальнейшую обработку для этого символа
            }
        }

        // Проверяем движение цены против позиции для фиксации убытка (если цена ушла более чем на 10% в убыток)
        if (isLosing && Math.abs(positionChange) >= LOSS_THRESHOLD) {
            log(`Порог убытка достигнут для ${symbol}: ${(positionChange * 100).toFixed(2)}%. Закрываем позицию.`);
            closePosition(symbol);
            return;
        }

        // Проверяем достижение цели прибыли
        if (!position.profitTargetReached && isProfitable && Math.abs(positionChange) >= PROFIT_TARGET) {
            position.profitTargetReached = true;
            position.peakPrice = currentPrice;
            log(`Цель по прибыли достигнута для ${symbol}: ${(positionChange * 100).toFixed(2)}%. Отслеживаем коррекцию.`);
        }

        // Отслеживаем коррекцию после достижения цели прибыли
        if (position.profitTargetReached) {
            let profitCorrection;
            if (position.side === 'BUY') {
                profitCorrection = (position.peakPrice - currentPrice) / position.peakPrice;
            } else {
                profitCorrection = (currentPrice - position.peakPrice) / position.peakPrice;
            }

            if (profitCorrection >= CORRECTION_AFTER_PROFIT) {
                log(`Коррекция цены после достижения цели прибыли для ${symbol}. Закрываем позицию.`);
                closePosition(symbol);
                return; // Прекращаем дальнейшую обработку для этого символа
            }
        }
    }
}

async function startTrading() {
    log('Запуск торговой системы');
    await getAccountBalance();
    const symbols = await getSymbolList();

    const streams = symbols.map(symbol => `${symbol.toLowerCase()}@ticker`);
    const maxStreamsPerConnection = 200;
    const connections = [];

    for (let i = 0; i < streams.length; i += maxStreamsPerConnection) {
        const streamSlice = streams.slice(i, i + maxStreamsPerConnection);
        const wsUrl = `${WS_BASE_URL}?streams=${streamSlice.join('/')}`;
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            log('WebSocket подключение установлено');
        });

        ws.on('message', (data) => {
            const parsedData = JSON.parse(data);
            if (parsedData.stream && parsedData.data) {
                handlePriceUpdate(parsedData.data);
            }
        });

        ws.on('error', (error) => {
            log(`WebSocket ошибка: ${error.message}`);
        });

        ws.on('close', () => {
            log('WebSocket подключение закрыто. Переподключаемся...');
            setTimeout(startTrading, 5000);
        });

        connections.push(ws);
    }
}

startTrading();