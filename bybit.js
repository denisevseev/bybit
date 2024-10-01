const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

// Ваши API ключи
const API_KEY = 'PDMeOejlai84O41KZ5Y8cTIiF51Gimx9YgNUFzmHavPOEJbR4UYVrPP2YOE6EADH';
const SECRET_KEY = 'YvSqzPfvPDFMiyrNWgb0rwGEFCZ3q4brrFcyQIkehuGf0R3brlVvNzHjNBC88z1a';

let currentBalance = 0; // Текущий баланс будет инициализирован после получения с API

const TRADE_AMOUNT_PERCENT = 0.1; // Торгуем 10% от доступного баланса

const CHANGE_THRESHOLD = 10; // Порог изменения цены для входа в сделку (в процентах)
const PROFIT_THRESHOLD = 2; // Порог прибыли для фиксации (в процентах)
const MAX_LOSS_THRESHOLD = 20; // Порог убытка для выхода из сделки (в процентах)
const MIN_PROFIT_AMOUNT = 4; // Минимальная прибыль для фиксации сделки (в USDT)
const MONITORING_PERIOD = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах

const MIN_VOLUME_USDT = 1000000; // Минимальный объем торгов в USDT за 24 часа для входа в сделку

let pairs = {}; // Объект для хранения состояния каждой валютной пары
let totalProfit = 0; // Общая прибыль в USDT
let totalLoss = 0; // Общий убыток в USDT

// Функция для подписи запроса
function signRequest(data) {
    return crypto.createHmac('sha256', SECRET_KEY).update(data).digest('hex');
}

// Функция для получения баланса с аккаунта Binance
async function getAccountBalance() {
    const endpoint = 'https://api.binance.com/api/v3/account';
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = signRequest(query);

    const url = `${endpoint}?${query}&signature=${signature}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'X-MBX-APIKEY': API_KEY
            }
        });

        const balances = response.data.balances;
        const usdtBalance = balances.find(b => b.asset === 'USDT');
        const availableBalance = parseFloat(usdtBalance.free); // Свободный баланс USDT

        logToFile(`Баланс аккаунта USDT: ${availableBalance} USDT`);
        return availableBalance;
    } catch (error) {
        logToFile(`Ошибка при получении баланса: ${error.message}`);
        throw new Error(`Ошибка при получении баланса: ${error.response ? error.response.data : error.message}`);
    }
}

// Функция для отправки запроса на реальную сделку на Binance
async function sendOrder(symbol, side, quantity) {
    const endpoint = 'https://api.binance.com/api/v3/order';
    const timestamp = Date.now();

    const params = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    const signature = signRequest(params);

    const url = `${endpoint}?${params}&signature=${signature}`;

    try {
        const response = await axios.post(url, {}, {
            headers: {
                'X-MBX-APIKEY': API_KEY
            }
        });

        logToFile(`Реальная сделка на Binance. Пара: ${symbol}, Направление: ${side}, Количество: ${quantity}`);
        return response.data;
    } catch (error) {
        logToFile(`Ошибка при отправке сделки на Binance: ${error.message}`);
        throw new Error(`Ошибка при отправке сделки: ${error.response ? error.response.data : error.message}`);
    }
}

// Функция для записи логов в файл
function logToFile(message) {
    const timestamp = new Date().toLocaleString();
    fs.appendFileSync('trades_log.txt', `${timestamp} - ${message}\n`);
}

// Функция для запуска WebSocket соединения
function startWebSocket() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr');

    ws.on('open', () => {
        console.log('WebSocket подключен к Binance');
    });

    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            tickers.forEach((ticker) => {
                processTicker(ticker);
            });
        } catch (error) {
            console.error('Ошибка при обработке сообщения:', error.message);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket ошибка:', error.message);
    });

    ws.on('close', () => {
        console.log('WebSocket соединение закрыто. Попытка переподключения...');
        setTimeout(startWebSocket, 5000); // Переподключение после задержки
    });
}

// Функция для обработки тикера
async function processTicker(ticker) {
    const symbol = ticker.s;
    const currentPrice = parseFloat(ticker.c);
    const volume24h = parseFloat(ticker.q); // Объем торгов за 24 часа в USDT

    // Фильтруем только пары с USDT и проверяем объем торгов
    if (!symbol.endsWith('USDT') || volume24h < MIN_VOLUME_USDT) {
        return;
    }

    const now = Date.now();

    // Инициализируем данные для пары, если это первая встреча
    if (!pairs[symbol]) {
        pairs[symbol] = {
            initialPrice: currentPrice,
            initialTime: now,
            inPosition: false,
            entryPrice: null,
            direction: null, // 'up' или 'down'
        };
    }

    const pairData = pairs[symbol];

    // Проверяем, прошло ли 24 часа с момента начала отслеживания
    if (now - pairData.initialTime >= MONITORING_PERIOD) {
        resetPairData(symbol, currentPrice, now);
        logToFile(`Сброс данных для пары ${symbol} после 24 часов.`);
    }

    // Если мы не в позиции
    if (!pairData.inPosition) {
        const priceChangePercent = ((currentPrice - pairData.initialPrice) / pairData.initialPrice) * 100;

        // Проверяем, можем ли мы войти в сделку
        if (Math.abs(priceChangePercent) >= CHANGE_THRESHOLD && currentBalance >= currentBalance * TRADE_AMOUNT_PERCENT) {
            // Входим в сделку
            const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
            const quantity = tradeAmount / currentPrice;

            try {
                // Отправляем реальный ордер на Binance
                await sendOrder(symbol, priceChangePercent > 0 ? 'BUY' : 'SELL', quantity);

                currentBalance -= tradeAmount;
                pairData.inPosition = true;
                pairData.entryPrice = currentPrice;
                pairData.direction = priceChangePercent > 0 ? 'up' : 'down';

                logToFile(`Вход в сделку по паре ${symbol} в направлении ${pairData.direction}. Цена открытия: ${currentPrice.toFixed(6)}`);
            } catch (error) {
                console.error(`Ошибка при отправке ордера: ${error.message}`);
            }
        }
    } else {
        // Мы в позиции, следим за ценой
        const movementSinceEntry = ((currentPrice - pairData.entryPrice) / pairData.entryPrice) * 100;
        const profitPercent = pairData.direction === 'up' ? movementSinceEntry : -movementSinceEntry;

        // Рассчитываем потенциальную прибыль в долларах
        const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
        const potentialProfit = (tradeAmount * profitPercent) / 100;

        // Фиксация прибыли только если она больше или равна MIN_PROFIT_AMOUNT
        if (profitPercent >= PROFIT_THRESHOLD && potentialProfit >= MIN_PROFIT_AMOUNT) {
            totalProfit += potentialProfit;
            currentBalance += tradeAmount + potentialProfit;

            logToFile(`Прибыль по ${symbol}: ${potentialProfit.toFixed(6)} USDT. Цена открытия: ${pairData.entryPrice.toFixed(6)}, Цена закрытия: ${currentPrice.toFixed(6)}, Процент изменения: ${profitPercent.toFixed(2)}%`);

            resetPairData(symbol, currentPrice, now); // Сбрасываем данные о сделке
        }

        // Фиксация убытка
        else if (profitPercent <= -MAX_LOSS_THRESHOLD) {
            const loss = (tradeAmount * MAX_LOSS_THRESHOLD) / 100;
            totalLoss += loss;
            currentBalance += tradeAmount - loss;

            logToFile(`Убыток по ${symbol}: ${loss.toFixed(6)} USDT. Цена открытия: ${pairData.entryPrice.toFixed(6)}, Цена закрытия: ${currentPrice.toFixed(6)}, Процент изменения: ${profitPercent.toFixed(2)}%`);

            resetPairData(symbol, currentPrice, now);
        }
    }
}

// Функция для сброса данных пары
function resetPairData(symbol, currentPrice, now) {
    pairs[symbol] = {
        initialPrice: currentPrice,
        initialTime: now,
        inPosition: false,
        entryPrice: null,
        direction: null,
    };
}

// Главная функция для старта стратегии
(async () => {
    try {
        // Получаем начальный баланс с аккаунта
        currentBalance = await getAccountBalance();
        logToFile(`Начальный баланс: ${currentBalance} USDT`);

        // Запускаем WebSocket для мониторинга
        startWebSocket();
    } catch (error) {
        console.error(`Ошибка: ${error.message}`);
    }
})();
