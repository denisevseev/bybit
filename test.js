const axios = require('axios');
const crypto = require('crypto');

// Binance API Configuration
const BASE_URL = 'https://api.binance.com';
const API_KEY = 'KA5ZrEOH4cxHCcg1g4eMgAvuDWQGusjLxYyxCT50mKIPl2w3gBfVM8BaLBQXfaK5';
const SECRET_KEY = 'PACFNMn9Axc7nzXduMARyM6FAW6DJbKzTodvWPkrdbt8DpEqlQFpVdukr9qSJNH2';

const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'spot_trade.log');

function log(message) {
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const logMessage = `[${timestamp}] ${message}\n`;

    try {
        if (!fs.existsSync(logFile)) {
            console.log('Создаём новый лог-файл.');
            fs.writeFileSync(logFile, '', 'utf8');
        }
        fs.appendFileSync(logFile, logMessage, 'utf8');
        console.log(message);
    } catch (error) {
        console.error(`Ошибка записи лога в файл: ${error.message}`);
    }
}

// Helper function to sign Binance API queries
function signQuery(params) {
    const query = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    return `${query}&signature=${signature}`;
}

async function getSymbolInfo(symbol) {
    try {
        const response = await axios.get(`${BASE_URL}/api/v3/exchangeInfo`);
        const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);

        if (!symbolInfo) {
            log(`Символ ${symbol} не найден на бирже.`);
            return null;
        }

        // Логируем всю информацию о символе для отладки
        log(`Информация о символе ${symbol}: ${JSON.stringify(symbolInfo)}`);

        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        let minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

        // Попытка найти NOTIONAL, если MIN_NOTIONAL отсутствует
        if (!minNotionalFilter) {
            const notionalFilter = symbolInfo.filters.find(f => f.filterType === 'NOTIONAL');
            if (notionalFilter && notionalFilter.minNotional) {
                minNotionalFilter = notionalFilter;
            }
        }

        if (!lotSizeFilter || !minNotionalFilter) {
            log(`Не найдены необходимые фильтры (LOT_SIZE или MIN_NOTIONAL/NOTIONAL) для символа ${symbol}.`);
            return null;
        }

        return {
            minQty: parseFloat(lotSizeFilter.minQty),
            stepSize: parseFloat(lotSizeFilter.stepSize),
            minNotional: parseFloat(minNotionalFilter.minNotional)
        };
    } catch (error) {
        log(`Ошибка при получении информации о символе ${symbol}: ${error.message}`);
        throw error;
    }
}

// Function to execute a market BUY order
async function buyFUNUSDT() {
    const symbol = 'FUNUSDT';
    const orderValue = 100; // 100 USDT
    try {
        const info = await getSymbolInfo(symbol);
        const currentPriceResponse = await axios.get(`${BASE_URL}/api/v3/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(currentPriceResponse.data.price);

        let quantity = Math.floor((orderValue / currentPrice) / info.stepSize) * info.stepSize;

        if (quantity * currentPrice < info.minNotional) {
            throw new Error(`Сумма сделки меньше минимально допустимой: ${info.minNotional}`);
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
        const response = await axios.post(`${BASE_URL}/api/v3/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY },
        });

        log(`Ордер на покупку ${symbol} выполнен: ${JSON.stringify(response.data)}`);
        return { symbol, quantity };
    } catch (error) {
        log(`Ошибка при покупке ${symbol}: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        throw error;
    }
}

// Function to execute a market SELL order
async function sellFUNUSDT(symbol, quantity) {
    try {
        const params = {
            symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity,
            recvWindow: 5000,
            timestamp: Date.now(),
        };

        const query = signQuery(params);
        const response = await axios.post(`${BASE_URL}/api/v3/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY },
        });

        log(`Ордер на продажу ${symbol} выполнен: ${JSON.stringify(response.data)}`);
    } catch (error) {
        log(`Ошибка при продаже ${symbol}: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        throw error;
    }
}

// Main execution function
(async function () {
    try {
        log('Начинаем покупку FUNUSDT...');
        const { symbol, quantity } = await buyFUNUSDT();

        log(`Ожидаем 3 секунды перед продажей ${symbol}...`);
        setTimeout(async () => {
            log(`Начинаем продажу ${symbol}...`);
            await sellFUNUSDT(symbol, quantity);
            log('Тест завершён.');
        }, 3000);
    } catch (error) {
        log(`Тест завершился с ошибкой: ${error.message}`);
    }
})();