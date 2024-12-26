const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Binance API Configuration
const BASE_URL = 'https://api.binance.com';
const WS_BASE_URL = 'wss://stream.binance.com:9443/stream';
const API_KEY = 'KA5ZrEOH4cxHCcg1g4eMgAvuDWQGusjLxYyxCT50mKIPl2w3gBfVM8BaLBQXfaK5';
const SECRET_KEY = 'PACFNMn9Axc7nzXduMARyM6FAW6DJbKzTodvWPkrdbt8DpEqlQFpVdukr9qSJNH2';
const PERCENT_CHANGE = 0.04;  // 7% price change for entry
const PROFIT_TARGET = 0.03;   // 3% profit target
const LOSS_THRESHOLD = 0.10;  // 10% stop-loss
const DYNAMIC_CORRECTION_LOW = 0.01; // 1% correction for <10% profit
const DYNAMIC_CORRECTION_HIGH = 0.05; // 5% correction for >=10% profit

let accountBalance = 0;
let openPositions = {}; // { symbol: { entryPrice, quantity, peakPrice } }
let priceHistory = {}; // { symbol: lastPrice }

const logFile = path.join(__dirname, 'spot_trade.log');

// Logging function
function log(message) {
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const logMessage = `[${timestamp}] ${message}\n`;

    try {
        if (!fs.existsSync(logFile)) {
            fs.writeFileSync(logFile, '', 'utf8');
        }
        fs.appendFileSync(logFile, logMessage, 'utf8');
        console.log(message);
    } catch (error) {
        console.error(`Ошибка записи лога: ${error.message}`);
    }
}

// Binance query signing
function signQuery(params) {
    const query = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    return `${query}&signature=${signature}`;
}

// Get account balance
async function getAccountBalance() {
    const params = { timestamp: Date.now(), recvWindow: 5000 };
    const query = signQuery(params);

    try {
        const response = await axios.get(`${BASE_URL}/api/v3/account?${query}`, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        const usdtBalance = response.data.balances.find(asset => asset.asset === 'USDT');
        accountBalance = usdtBalance ? parseFloat(usdtBalance.free) : 0;
        log(`Баланс USDT: ${accountBalance.toFixed(2)} USDT`);
    } catch (error) {
        log(`Ошибка получения баланса: ${error.message}`);
    }
}

// Fetch trading pairs
async function getSymbolList() {
    try {
        const response = await axios.get(`${BASE_URL}/api/v3/exchangeInfo`);
        return response.data.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol);
    } catch (error) {
        log(`Ошибка получения списка символов: ${error.message}`);
        return [];
    }
}

async function getSymbolInfo(symbol) {
    try {
        const response = await axios.get(`${BASE_URL}/api/v3/exchangeInfo`);
        const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);

        if (!symbolInfo) {
            log(`Символ ${symbol} не найден.`);
            return null;
        }

        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotionalFilter = symbolInfo.filters.find(f => 
            f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL'
        );

        return {
            minQty: parseFloat(lotSizeFilter?.minQty || 0), // Обработка отсутствия minQty
            stepSize: parseFloat(lotSizeFilter?.stepSize || 0), // Обработка отсутствия stepSize
            minNotional: parseFloat(minNotionalFilter?.minNotional || minNotionalFilter?.notional || 0) // Проверка обоих свойств
        };
    } catch (error) {
        log(`Ошибка получения информации о символе ${symbol}: ${error.message}`);
        throw error;
    }
}


// Place a market BUY order
async function placeBuyOrder(symbol, price) {
    const orderValue = Math.max(accountBalance / 10, 100); // 1/10 баланса, минимум 100 USDT
    const info = await getSymbolInfo(symbol);

    let quantity = Math.floor((orderValue / price) / info.stepSize) * info.stepSize;

    if (quantity * price < info.minNotional) {
        log(`Сумма сделки ${quantity * price} меньше минимальной: ${info.minNotional}`);
        return null;
    }

    const params = {
        symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity,
        recvWindow: 5000,
        timestamp: Date.now(),
    };

    const query = signQuery(params);

    try {
        await axios.post(`${BASE_URL}/api/v3/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        log(`Куплено ${symbol}: ${quantity}`);
        openPositions[symbol] = { entryPrice: price, quantity, peakPrice: price };
        return { quantity };
    } catch (error) {
        log(`Ошибка покупки ${symbol}: ${error.message}`);
        return null;
    }
}

// Place a market SELL order
async function placeSellOrder(symbol, position) {
    const sellQuantity = Math.floor(position.quantity * 0.99 / position.quantity) * position.quantity; // Учёт комиссии

    const params = {
        symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: sellQuantity,
        recvWindow: 5000,
        timestamp: Date.now(),
    };

    const query = signQuery(params);

    try {
        await axios.post(`${BASE_URL}/api/v3/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        log(`Продано ${symbol}: ${sellQuantity}`);
        delete openPositions[symbol];
    } catch (error) {
        log(`Ошибка продажи ${symbol}: ${error.message}`);
    }
}

// Handle price updates
function handlePriceUpdate(symbol, currentPrice) {
    if (!openPositions[symbol]) {
        const oldPrice = priceHistory[symbol];
        if (oldPrice && (currentPrice - oldPrice) / oldPrice >= PERCENT_CHANGE) {
            placeBuyOrder(symbol, currentPrice);
        } else {
            priceHistory[symbol] = currentPrice;
        }
    } else {
        const position = openPositions[symbol];
        const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;

        if (currentPrice > position.peakPrice) position.peakPrice = currentPrice;

        const correction = priceChange < 0.10 ? DYNAMIC_CORRECTION_LOW : DYNAMIC_CORRECTION_HIGH;
        const correctionFromPeak = (position.peakPrice - currentPrice) / position.peakPrice;

        if (correctionFromPeak >= correction || priceChange <= -LOSS_THRESHOLD) {
            placeSellOrder(symbol, position);
        }
    }
}

let timeOffset = 0; // Смещение времени между сервером и Binance

// Функция синхронизации времени
async function syncTime() {
    try {
        const response = await axios.get(`${BASE_URL}/api/v3/time`);
        const serverTime = response.data.serverTime;
        const localTime = Date.now();
        timeOffset = serverTime - localTime;
        log(`Синхронизация времени выполнена. Смещение: ${timeOffset} мс.`);
    } catch (error) {
        log(`Ошибка синхронизации времени: ${error.message}`);
    }
}

// Функция для получения текущей временной метки с учётом смещения
function getTimestamp() {
    return Date.now() + timeOffset;
}

// Обновление signQuery с учётом синхронизации времени
function signQuery(params) {
    params.timestamp = getTimestamp(); // Используем синхронизированное время
    const query = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    return `${query}&signature=${signature}`;
}

// Вызов синхронизации времени перед началом работы
async function startTrading() {
    log('Инициализация торговли...');
    await syncTime(); // Сначала синхронизируем время
    await getAccountBalance();
    const symbols = await getSymbolList();

    const streams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`${WS_BASE_URL}?streams=${streams}`);

    ws.on('open', () => log('WebSocket подключен.'));
    ws.on('message', data => {
        const parsed = JSON.parse(data);
        if (parsed.stream && parsed.data) {
            const { s: symbol, c: currentPrice } = parsed.data;
            handlePriceUpdate(symbol, parseFloat(currentPrice));
        }
    });
    ws.on('error', error => log(`WebSocket ошибка: ${error.message}`));
    ws.on('close', () => {
        log('WebSocket закрыт. Перезапуск...');
        setTimeout(startTrading, 5000);
    });
}

startTrading();