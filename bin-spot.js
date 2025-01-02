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
const PERCENT_CHANGE = 0.07;  // 4% изменение цены для входа
const PROFIT_TARGET = 0.03;   // 3% цель прибыли
const LOSS_THRESHOLD = 0.10;  // 10% стоп-лосс
const TRAILING_DELTA = 500;   // 5% трейлинг-стоп (500 пунктов)

let accountBalance = 0;
let openPositions = {}; // { symbol: { entryPrice, quantity, orderId, peakPrice } }
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

// Get available balance for a specific asset
async function getAvailableBalance(asset) {
    const params = { timestamp: Date.now(), recvWindow: 5000 };
    const query = signQuery(params);
    try {
        const response = await axios.get(`${BASE_URL}/api/v3/account?${query}`, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        const balance = response.data.balances.find(b => b.asset === asset);
        return balance ? parseFloat(balance.free) : 0;
    } catch (error) {
        log(`Ошибка получения баланса для ${asset}: ${error.message}`);
        return 0;
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
        if (!symbolInfo) return null;
        
        const notionalFilter = symbolInfo.filters.find(
            f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL'
        );
        
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        
        return {
            minNotional: parseFloat(notionalFilter?.minNotional || notionalFilter?.notional || 0),
            stepSize: parseFloat(lotSizeFilter?.stepSize || 0),
            minQty: parseFloat(lotSizeFilter?.minQty || 0),
        };
    } catch (error) {
        log(`Ошибка получения информации о ${symbol}: ${error.message}`);
        return null;
    }
}



// Place a market BUY order
async function placeBuyOrder(symbol, price) {
    log(`попотыка купить монету ${symbol}`)
    const orderValue = Math.max(accountBalance / 10, 100); // 1/10 баланса, минимум 100 USDT
    const asset = symbol.replace('USDT', '');
    const info = await getSymbolInfo(symbol);
    if (!info) {
        log(`Не удалось получить информацию о символе ${symbol}`);
        return null;
    }

    let quantity = Math.floor((orderValue / price) / info.stepSize) * info.stepSize;
    if (quantity * price < info.minNotional || quantity < info.minQty) {
        log(`Сумма сделки ${quantity * price} меньше минимальной: ${info.minNotional} или количество меньше минимального ${info.minQty}`);
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
        const response = await axios.post(`${BASE_URL}/api/v3/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        const orderId = response.data.orderId;
        log(`Куплено ${symbol}: ${quantity}, orderId: ${orderId}`);
        openPositions[symbol] = { entryPrice: price, quantity, orderId, peakPrice: price };
        return { quantity, orderId };
    } catch (error) {
        log(`Ошибка покупки ${symbol}: ${error.message}`);
        if (error.response) {
             log(`Ответ Binance: ${JSON.stringify(error.response.data)}`);
        }
        return null;
    }
}



// Place a trailing stop SELL order (STOP_LOSS_LIMIT)
async function placeSellOrderWithTrailingStop(symbol, currentPrice) {
    const asset = symbol.replace('USDT', '');
    const availableQuantity = await getAvailableBalance(asset);
    const symbolInfo = await getSymbolInfo(symbol);

    if (!symbolInfo) {
        log(`Не удалось получить информацию о символе ${symbol}`);
        return;
    }

    if (availableQuantity <= 0 || availableQuantity < symbolInfo.minQty) {
        log(`Нет доступных монет для продажи ${symbol} или количество меньше минимального.`);
        return;
    }

    const quantity = Math.floor(availableQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;

    // Рассчитываем stopPrice (необходимо настроить под вашу стратегию!)
    const stopPrice = currentPrice * (1 - 0.01); // Например, 1% ниже текущей цены
    
    const params = {
        symbol,
        side: 'SELL',
        type: 'STOP_LOSS_LIMIT',
        quantity: quantity.toFixed(8),
        timeInForce: 'GTC',
        price: stopPrice.toFixed(8), // Цена для исполнения
        stopPrice: stopPrice.toFixed(8), // Цена активации стоп-лосса
        trailingDelta: TRAILING_DELTA,
        recvWindow: 5000,
        timestamp: Date.now(),
    };


    const query = signQuery(params);

    try {
        const response = await axios.post(`${BASE_URL}/api/v3/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        log(`Установлен трейлинг-стоп для ${symbol}: отклонение ${TRAILING_DELTA} пунктов, quantity: ${quantity.toFixed(8)}, stopPrice: ${stopPrice.toFixed(8)}`);
        return response.data;

    } catch (error) {
        log(`Ошибка установки трейлинг-стопа для ${symbol}: ${error.message}`);
        if (error.response && error.response.data) {
            log(`Ответ Binance: ${JSON.stringify(error.response.data)}`);
        }
    }
}


// Handle price updates
function handlePriceUpdate(symbol, currentPrice) {
    if (!openPositions[symbol]) {
        // ... (логика покупки)
        const oldPrice = priceHistory[symbol];

        if (oldPrice && (currentPrice - oldPrice) / oldPrice >= PERCENT_CHANGE) {
            placeBuyOrder(symbol, currentPrice)
                .then(buyResult => {
                    if (buyResult) {
                        openPositions[symbol] = {
                           ...buyResult,
                           peakPrice: currentPrice,
                           entryPrice: currentPrice,
                        };
                    }
                });
        } else {
            priceHistory[symbol] = currentPrice;
        }
    } else {
        const position = openPositions[symbol];
        const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
        if (currentPrice > position.peakPrice) {
            position.peakPrice = currentPrice;
        }


        if (priceChange >= PROFIT_TARGET || priceChange <= -LOSS_THRESHOLD) {
            placeSellOrderWithTrailingStop(symbol, currentPrice);
            delete openPositions[symbol]; // Удаляем позицию после установки ордера на продажу
        }
    }
}


async function startTrading() {
    log('Инициализация торговли...');
    await getAccountBalance();
    const symbols = await getSymbolList();
    const streams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`${WS_BASE_URL}?streams=${streams}`);


    ws.on('open', () => log('WebSocket подключен.'));
    ws.on('message', data => {
        try {
            const parsed = JSON.parse(data);

            if (parsed.stream && parsed.data) {
                const { s: symbol, c: currentPrice } = parsed.data;
                handlePriceUpdate(symbol, parseFloat(currentPrice));
            }
        } catch (error) {
            log(`Ошибка обработки данных WebSocket: ${error.message}`);
        }
    });


    ws.on('error', error => log(`WebSocket ошибка: ${error.message}`));
    ws.on('close', () => {
        log('WebSocket закрыт. Перезапуск...');
        setTimeout(startTrading, 5000);
    });
}

startTrading();