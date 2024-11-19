const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

const BASE_URL = 'https://fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com/stream';
const API_KEY = 'R7nkPfaYEmtCYEgE4kCQQy4WHdkOUOTgyDKHIcvyBP3qVEWCkDIhUuOHYUjhQUG5';
const SECRET_KEY = 'EZBzLuzGFuNaK3xiRt7bcWmkqKdqJdfhwEtP5p9JThemrRj10PD0GvUvNXAxXMa7';
const PERCENT_CHANGE = 0.05;
const MIN_CONTINUE_CHANGE = 0.03;
const MAX_CORRECTION = 0.01;
// const STABILITY_DURATION = 60 * 1000; // 1 минута в миллисекундах
const STABILITY_DURATION = 1; // удержание цены

let accountBalance = 0;
let lastPrices = {};
let openPositions = {}; // Хранит открытые позиции для каждого символа
let stableTimestamps = {}; // Хранит время достижения 5% изменения для стабильности
let priceUpdates = {}; // Хранит последние обновления цен из WebSocket

// Функция для подписи запроса
function signQuery(params) {
    const query = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    return `${query}&signature=${signature}`;
}

// Функция для получения информации о символе
async function getSymbolInfo(symbol) {
    try {
        const response = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
        const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
        if (!symbolInfo) throw new Error(`Символ ${symbol} не найден`);
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        return {
            minQty: parseFloat(lotSizeFilter.minQty),
            stepSize: parseFloat(lotSizeFilter.stepSize),
            minNotional: parseFloat(minNotionalFilter.notional)
        };
    } catch (error) {
        console.error(`Ошибка при получении параметров символа ${symbol}: ${error.message}`);
        throw error;
    }
}

// Функция для округления количества по шагу
function roundStepSize(quantity, stepSize) {
    const precision = Math.round(-Math.log10(stepSize));
    const qty = Math.ceil(quantity / stepSize) * stepSize;
    return parseFloat(qty.toFixed(precision));
}

// Получение баланса и разделение на 10 частей для торговли
async function getAccountBalance() {
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

        console.log(`Баланс аккаунта: ${usdtBalance.walletBalance}, Доступно для сделки: ${accountBalance / 10}`);
    } catch (error) {
        console.error(`Ошибка при получении баланса: ${error.response ? error.response.data.msg : error.message}`);
    }
}

// Получение списка торговых символов с базовой валютой USDT
async function getSymbolList() {
    try {
        const response = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
        const symbols = response.data.symbols
            .filter(symbol => symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING')
            .map(symbol => symbol.symbol);
        console.log("Список символов загружен.");
        return symbols;
    } catch (error) {
        console.error(`Ошибка при получении списка символов: ${error.message}`);
        return [];
    }
}

// Функция для открытия позиции (лонг или шорт) на 1/10 баланса
async function openPosition(symbol, side) {
    if (accountBalance === 0) {
        console.error(`Недостаточный баланс для открытия позиции по ${symbol}.`);
        return;
    }

    // Используем либо 1/10 баланса, либо минимальную сумму в 100 USDT, в зависимости от того, что больше
    let orderValue = Math.max(accountBalance / 10, 100);

    // Получаем информацию о символе
    const { minQty, stepSize } = await getSymbolInfo(symbol);

    // Получаем текущую цену символа из WebSocket
    const price = priceUpdates[symbol];
    if (!price) {
        console.error(`Нет текущей цены для символа ${symbol}.`);
        return;
    }

    // Рассчитываем минимальное количество для notional >= 100 USDT
    let minQuantity = 100 / price;

    // Округляем до ближайшего допустимого количества вверх
    minQuantity = Math.ceil(minQuantity / stepSize) * stepSize;
    minQuantity = Math.max(minQuantity, minQty);

    // Рассчитываем количество на основе orderValue
    let quantity = orderValue / price;

    // Округляем количество по шагу вверх
    quantity = roundStepSize(quantity, stepSize);

    // Убеждаемся, что quantity >= minQuantity
    if (quantity < minQuantity) {
        quantity = minQuantity;
        orderValue = quantity * price;
    }

    // Вычисляем notional после округления
    let notional = quantity * price;

    // Проверяем, что orderValue не превышает accountBalance
    if (orderValue > accountBalance) {
        console.error(`Недостаточно средств для открытия позиции по ${symbol}. Требуется ${orderValue.toFixed(2)} USDT, доступно ${accountBalance.toFixed(2)} USDT.`);
        return;
    }

    // Выводим значения для отладки
    console.log(`Попытка открыть позицию по ${symbol} с количеством ${quantity} и номинальной стоимостью ${notional.toFixed(2)} USDT.`);

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
        console.log(`Открыта ${side} позиция по ${symbol}: количество ${quantity}, номинал ${notional.toFixed(2)} USDT`);
        openPositions[symbol] = { side, entryPrice: price, quantity };
        accountBalance -= orderValue; // Уменьшаем баланс на величину позиции
    } catch (error) {
        console.error(`Ошибка при открытии позиции для ${symbol}: ${error.response ? error.response.data.msg : error.message}`);
    }
}

// Закрытие позиции для фиксации прибыли или убытка
async function closePosition(symbol) {
    const position = openPositions[symbol];
    if (!position) return;

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
        console.log(`Позиция по ${symbol} закрыта.`);
        delete openPositions[symbol];
        // Опционально: обновить баланс аккаунта на основе прибыли или убытка
    } catch (error) {
        console.error(`Ошибка при закрытии позиции для ${symbol}: ${error.response ? error.response.data.msg : error.message}`);
    }
}

// Функция для обработки обновлений цен из WebSocket
function handlePriceUpdate(data) {
    const symbol = data.s;
    const currentPrice = parseFloat(data.c);

    const currentTime = Date.now();

    if (!symbol || !currentPrice) return;

    if (lastPrices[symbol]) {
        const previousPrice = lastPrices[symbol];
        const percentChange = (currentPrice - previousPrice) / previousPrice;

        // Проверка на 5% изменение
        if (!openPositions[symbol] && Math.abs(percentChange) >= PERCENT_CHANGE) {
            if (!stableTimestamps[symbol]) {
                stableTimestamps[symbol] = currentTime;
            } else if (currentTime - stableTimestamps[symbol] >= STABILITY_DURATION) {
                const direction = percentChange > 0 ? 'BUY' : 'SELL';
                console.log(`Символ: ${symbol}, цена изменилась на ${(percentChange * 100).toFixed(2)}%. Открываем позицию ${direction}.`);
                openPosition(symbol, direction);
                delete stableTimestamps[symbol];
            }
        } else {
            delete stableTimestamps[symbol];
        }

        // Условия для закрытия позиции
        if (openPositions[symbol]) {
            const position = openPositions[symbol];
            const entryPrice = position.entryPrice;
            const positionChange = (currentPrice - entryPrice) / entryPrice;

            if (positionChange * percentChange > 0 && Math.abs(positionChange) >= MIN_CONTINUE_CHANGE) {
                const correction = Math.abs((currentPrice - previousPrice) / currentPrice);
                if (correction <= MAX_CORRECTION) {
                    console.log(`Символ: ${symbol}, цена изменилась на ${(positionChange * 100).toFixed(2)}%. Фиксируем прибыль.`);
                    closePosition(symbol);
                }
            }

            if (positionChange * percentChange < 0 && Math.abs(positionChange) >= MIN_CONTINUE_CHANGE) {
                console.log(`Символ: ${symbol}, цена изменилась на ${(positionChange * 100).toFixed(2)}%. Закрываем с убытком.`);
                closePosition(symbol);
            }
        }
    }

    lastPrices[symbol] = currentPrice;
}

// Запуск торговой системы с использованием WebSocket
async function startTrading() {
    await getAccountBalance();
    const symbols = await getSymbolList();

    // Подключение к WebSocket для получения цен
    const streams = symbols.map(symbol => `${symbol.toLowerCase()}@ticker`);
    const wsUrl = `${WS_BASE_URL}?streams=${streams.join('/')}`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log('WebSocket соединение установлено.');
    });

    ws.on('message', (data) => {
        const parsedData = JSON.parse(data);
        if (parsedData.stream && parsedData.data) {
            handlePriceUpdate(parsedData.data);
            // Обновляем последнюю цену
            priceUpdates[parsedData.data.s] = parseFloat(parsedData.data.c);
        }
    });

    ws.on('error', (error) => {
        console.error(`Ошибка WebSocket: ${error.message}`);
    });

    ws.on('close', () => {
        console.log('WebSocket соединение закрыто. Повторное подключение...');
        setTimeout(startTrading, 5000); // Повторное подключение через 5 секунд
    });
}

startTrading();