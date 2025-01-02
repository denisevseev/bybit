

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://fapi.binance.com';
const API_KEY = 'R7nkPfaYEmtCYEgE4kCQQy4WHdkOUOTgyDKHIcvyBP3qVEWCkDIhUuOHYUjhQUG5';
const SECRET_KEY = 'EZBzLuzGFuNaK3xiRt7bcWmkqKdqJdfhwEtP5p9JThemrRj10PD0GvUvNXAxXMa7';
const logFile = path.join(__dirname, 'trade.log');

// Вспомогательная функция для подписи запросов
function signQuery(params) {
    const query = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    return `${query}&signature=${signature}`;
}

// Округление количества к шагу
function roundStepSize(quantity, stepSize) {
    return Math.floor(quantity / stepSize) * stepSize;
}

// Логирование
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

// Функция для открытия позиции
async function openPosition(symbol, direction = 'BUY') {
    try {
        // Получение информации о символе (лотность, шаг)
        const exchangeInfo = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
        const symbolInfo = exchangeInfo.data.symbols.find(s => s.symbol === symbol);

        if (!symbolInfo) {
            log(`Символ ${symbol} не найден.`);
            return;
        }

        const { filters } = symbolInfo;
        const minQty = parseFloat(filters.find(f => f.filterType === 'LOT_SIZE').minQty);
        const stepSize = parseFloat(filters.find(f => f.filterType === 'LOT_SIZE').stepSize);
        const minNotional = parseFloat(filters.find(f => f.filterType === 'MIN_NOTIONAL').notional || 0);

        // Получение текущей цены символа
        const ticker = await axios.get(`${BASE_URL}/fapi/v1/ticker/price`, { params: { symbol } });
        const price = parseFloat(ticker.data.price);

        // Расчёт количества для 100 USDT
        let quantity = 100 / price; // На 100 USDT
        quantity = roundStepSize(quantity, stepSize); // Округление к шагу

        // Проверка минимального количества
        if (quantity < minQty || quantity * price < minNotional) {
            log(`Невозможно открыть позицию. Минимальный размер: ${minQty}, минимальная стоимость: ${minNotional}.`);
            return;
        }

        // Параметры ордера
        const params = {
            symbol,
            side: direction,
            type: 'MARKET',
            quantity,
            timestamp: Date.now(),
            recvWindow: 5000,
        };
        const query = signQuery(params);

        // Отправка ордера
        const response = await axios.post(`${BASE_URL}/fapi/v1/order?${query}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });

        log(`Позиция открыта: ${symbol}, направление: ${direction}, количество: ${quantity}`);
        log(`Ответ Binance: ${JSON.stringify(response.data)}`);
    } catch (error) {
        log(`Ошибка при открытии позиции: ${error.response ? error.response.data.msg : error.message}`);
    }
}

// Запуск функции
(async () => {
    const symbol = 'ETHUSDT'; // Символ для торговли
    const direction = 'BUY'; // Направление: BUY или SELL
    await openPosition(symbol, direction);
})();
