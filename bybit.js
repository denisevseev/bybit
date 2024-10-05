const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

const API_KEY = 'PDMeOejlai84O41KZ5Y8cTIiF51Gimx9YgNUFzmHavPOEJbR4UYVrPP2YOE6EADH';
const SECRET_KEY = 'YvSqzPfvPDFMiyrNWgb0rwGEFCZ3q4brrFcyQIkehuGf0R3brlVvNzHjNBC88z1a';
const BASE_URL = 'https://api.binance.com';

let currentBalance = 0;
let activeTradeAmount = 0;
const TRADE_AMOUNT_PERCENT = 0.1;
const CHANGE_THRESHOLD = 7;
const PROFIT_THRESHOLD = 5;
const MIN_PROFIT_OR_LOSS_AMOUNT = 4;
const MONITORING_PERIOD = 24 * 60 * 60 * 1000;
const MIN_VOLUME_USDT = 100000;

let pairs = {};

function logToFile(message) {
    const timestamp = new Date().toLocaleString();
    fs.appendFileSync('trades_log.txt', `${timestamp} - ${message}\n`);
}

function signQuery(query) {
    return crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
}



async function getSymbolInfo(symbol) {
    const endpoint = '/api/v3/exchangeInfo';
    const url = `${BASE_URL}${endpoint}`;

    try {
        const response = await axios.get(url);
        const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
        if (!symbolInfo) {
            throw new Error(`Информация о паре ${symbol} не найдена.`);
        }
        return symbolInfo;
    } catch (error) {
        logToFile(`Ошибка при получении информации о символе: ${error.message}`);
        throw error;
    }
}

async function calculateMinQuantity(symbol, currentPrice) {
    try {
        const symbolInfo = await getSymbolInfo(symbol);
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minQty = parseFloat(lotSizeFilter.minQty);
        const stepSize = parseFloat(lotSizeFilter.stepSize);
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        const minNotional = minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : null;
        let tradeQuantity = minQty;
        tradeQuantity = Math.floor(tradeQuantity / stepSize) * stepSize;

        if (minNotional && tradeQuantity * currentPrice < minNotional) {
            tradeQuantity = minNotional / currentPrice;
            tradeQuantity = Math.floor(tradeQuantity / stepSize) * stepSize;
        }

        logToFile(`Рассчитанное минимальное количество для ${symbol}: ${tradeQuantity}`);
        return tradeQuantity;
    } catch (error) {
        logToFile(`Ошибка при расчете минимального количества для ${symbol}: ${error.message}`);
        throw error;
    }
}

async function getBalance() {
    const endpoint = '/api/v3/account';
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = signQuery(query);
    const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;

    try {
        const response = await axios.get(url, {
            headers: { 'X-MBX-APIKEY': API_KEY },
        });

        const balances = response.data.balances;
        const usdtBalance = balances.find(b => b.asset === 'USDT');
        if (!usdtBalance) {
            throw new Error('Баланс USDT не найден');
        }

        currentBalance = parseFloat(usdtBalance.free);
        logToFile(`Баланс USDT успешно получен: ${currentBalance.toFixed(2)} USDT`);
        return currentBalance;
    } catch (error) {
        logToFile(`Ошибка при получении баланса: ${error.message}`);
        throw error;
    }
}

async function createOrder(symbol, side, quantity) {
    const endpoint = '/api/v3/order';
    const timestamp = Date.now();
    const query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    const signature = signQuery(query);
    const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;

    try {
        const response = await axios.post(url, null, {
            headers: { 'X-MBX-APIKEY': API_KEY },
        });

        logToFile(`Успешно создан ордер: ${side} ${symbol}, количество: ${quantity}`);
        return response.data;
    } catch (error) {
        logToFile(`Ошибка при создании ордера: ${error.message}`);
        throw error;
    }
}

async function processTicker(ticker) {
    const symbol = ticker.s;
    const currentPrice = parseFloat(ticker.c);
    const volume24h = parseFloat(ticker.q);

    if (!symbol.endsWith('USDT') || volume24h < MIN_VOLUME_USDT) {
        return;
    }

    const now = Date.now();

    if (!pairs[symbol]) {
        pairs[symbol] = {
            initialPrice: currentPrice,
            initialTime: now,
            inPosition: false,
            entryPrice: null,
            direction: null,
            trailingStopActive: false,
            highestPrice: null,
            disableMonitoring: false,
        };
        logToFile(`Новая пара добавлена для отслеживания: ${symbol}, начальная цена: ${currentPrice}`);
        return;
    }

    const pairData = pairs[symbol];

    if (now - pairData.initialTime >= MONITORING_PERIOD && !pairData.inPosition && !pairData.disableMonitoring) {
        resetPairData(symbol, currentPrice, now);
        logToFile(`Сброс данных для пары ${symbol} после 24 часов`);
    }

    if (!pairData.inPosition) {
        const priceChangePercent = ((currentPrice - pairData.initialPrice) / pairData.initialPrice) * 100;

        if (Math.abs(priceChangePercent) >= CHANGE_THRESHOLD) {
            await createOrderWithMinCheck(symbol, priceChangePercent > 0 ? 'BUY' : 'SELL', currentPrice);
            pairData.inPosition = true;
            pairData.entryPrice = currentPrice;
            pairData.direction = priceChangePercent > 0 ? 'up' : 'down';
            pairData.highestPrice = currentPrice;
            pairData.disableMonitoring = true;

            logToFile(`Вход в сделку по паре ${symbol} в направлении ${pairData.direction}. Цена открытия: ${currentPrice.toFixed(6)}`);
        }
    } else {
        const movementSinceEntry = ((currentPrice - pairData.entryPrice) / pairData.entryPrice) * 100;
        const profitPercent = pairData.direction === 'up' ? movementSinceEntry : -movementSinceEntry;
        const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
        const potentialProfitOrLoss = (tradeAmount * profitPercent) / 100;
        const tradeQuantity = (tradeAmount / currentPrice).toFixed(6);

        if (profitPercent >= PROFIT_THRESHOLD) {
            pairData.trailingStopActive = true;
            pairData.highestPrice = Math.max(pairData.highestPrice, currentPrice);

            const trailingStopPercent = Math.max(4, potentialProfitOrLoss * 0.5);
            const trailingStopThreshold = ((pairData.highestPrice - currentPrice) / pairData.highestPrice) * 100;

            if (trailingStopThreshold >= trailingStopPercent && potentialProfitOrLoss >= MIN_PROFIT_OR_LOSS_AMOUNT) {
                await createOrder(symbol, pairData.direction === 'up' ? 'SELL' : 'BUY', tradeQuantity);
                logToFile(`Фиксация прибыли по паре ${symbol}: ${profitPercent.toFixed(2)}%`);
                resetPairData(symbol, currentPrice, now);
            }
        } else if (profitPercent <= -CHANGE_THRESHOLD && potentialProfitOrLoss <= -MIN_PROFIT_OR_LOSS_AMOUNT) {
            await createOrder(symbol, pairData.direction === 'up' ? 'SELL' : 'BUY', tradeQuantity);
            logToFile(`Фиксация убытка по паре ${symbol}: ${profitPercent.toFixed(2)}%`);
            resetPairData(symbol, currentPrice, now);
        }
    }
}

function resetPairData(symbol, currentPrice, now) {
    pairs[symbol] = {
        initialPrice: currentPrice,
        initialTime: now,
        inPosition: false,
        entryPrice: null,
        direction: null,
        trailingStopActive: false,
        highestPrice: null,
        disableMonitoring: false,
    };
    logToFile(`Сброс данных для пары ${symbol}`);
}

async function createOrderWithMinCheck(symbol, side, currentPrice) {
    try {
        await getBalance();
        let tradeQuantity = await calculateMinQuantity(symbol, currentPrice);

        if (tradeQuantity * currentPrice > currentBalance) {
            logToFile(`Недостаточно средств для минимального входа в ${symbol}. Требуется: ${(tradeQuantity * currentPrice).toFixed(2)} USDT, доступно: ${currentBalance.toFixed(2)} USDT`);
            return;
        }

        await createOrder(symbol, side, tradeQuantity);
        logToFile(`Успешно создан ордер с минимальным количеством: ${side} ${symbol}, количество: ${tradeQuantity}`);
    } catch (error) {
        logToFile(`Ошибка при создании ордера для ${symbol}: ${error.message}`);
    }
}

async function init() {
    try {
        await getBalance();
        startWebSocket();
    } catch (error) {
        logToFile(`Ошибка при инициализации: ${error.message}`);
    }
}

function startWebSocket() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr');

    ws.on('open', () => {
        logToFile('WebSocket подключен к Binance');
    });

    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            tickers.forEach((ticker) => {
                processTicker(ticker);
            });
        } catch (error) {
            logToFile(`Ошибка при обработке сообщения: ${error.message}`);
        }
    });

    ws.on('error', (error) => {
        logToFile(`WebSocket ошибка: ${error.message}`);
    });

    ws.on('close', () => {
        logToFile('WebSocket соединение закрыто. Переподключение...');
        setTimeout(startWebSocket, 5000);
    });
}

init();
