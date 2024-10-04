const WebSocket = require('ws');
const fs = require('fs');

// Параметры стратегии
const INITIAL_BALANCE = 1000; // Начальный баланс в USDT
let currentBalance = INITIAL_BALANCE; // Текущий баланс
let activeTradeAmount = 0; // Сумма активных сделок
const TRADE_AMOUNT_PERCENT = 0.1; // Торгуем 10% от доступного баланса

const CHANGE_THRESHOLD = 6; // Порог изменения цены для входа в сделку (в процентах)
const PROFIT_THRESHOLD = 2; // Порог прибыли для фиксации (в процентах)
const MAX_LOSS_THRESHOLD = 20; // Порог убытка для выхода из сделки (в процентах)
const MIN_PROFIT_OR_LOSS_AMOUNT = 4; // Минимальная прибыль или убыток в USDT для фиксации

const MONITORING_PERIOD = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах
const ADDITIONAL_PROFIT_THRESHOLD = 5; // Дополнительный порог прибыли для фиксации отклонения
const TRAILING_STOP_THRESHOLD = 2; // Порог отклонения при следовании за прибылью

// Минимальный объем торгов в USDT за 24 часа для входа в сделку
const MIN_VOLUME_USDT = 100000;

// Объект для хранения состояния каждой валютной пары
let pairs = {};

// Переменные для учета прибыли и убытков
let totalProfit = 0; // Общая прибыль в USDT
let totalLoss = 0; // Общий убыток в USDT

// Функция для записи в лог-файл
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
function processTicker(ticker) {
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
            inPosition: false, // Важная проверка - пока бот не в позиции
            entryPrice: null,
            direction: null, // 'up' или 'down'
            trailingStopActive: false, // Переменная для активации следования за прибылью
            highestPrice: null, // Для хранения самой высокой цены, достигнутой после входа
        };
        // logToFile(`Инициализация данных для пары ${symbol}. Цена: ${currentPrice}`);
        return;
    }

    const pairData = pairs[symbol];

    // Проверяем, прошло ли 24 часа с момента начала отслеживания
    if (now - pairData.initialTime >= MONITORING_PERIOD) {
        if (!pairData.inPosition) {
            // Сбрасываем данные только по парам, по которым мы не в позиции
            resetPairData(symbol, currentPrice, now);
            console.log(`Сброс данных для пары ${symbol} после 24 часов.`);
        } else {
            // Логируем, что мы продолжаем следить за позицией
            console.log(`Пара ${symbol} остается под наблюдением, так как бот в позиции.`);
        }
    }

    // Если мы не в позиции
    if (!pairData.inPosition) {
        const priceChangePercent = ((currentPrice - pairData.initialPrice) / pairData.initialPrice) * 100;

        // Проверяем, можем ли мы войти в сделку
        const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
        if (Math.abs(priceChangePercent) >= CHANGE_THRESHOLD && currentBalance - activeTradeAmount >= tradeAmount) {
            // Входим в сделку
            activeTradeAmount += tradeAmount; // Увеличиваем активный объем сделок
            pairData.inPosition = true;
            pairData.entryPrice = currentPrice;
            pairData.direction = priceChangePercent > 0 ? 'up' : 'down';
            pairData.highestPrice = currentPrice; // Инициализируем самую высокую цену как цену входа

            // Записываем вход в сделку
            logToFile(`Вход в сделку по паре ${symbol} в направлении ${pairData.direction}. Цена открытия: ${currentPrice.toFixed(6)}`);
        }
    } else {
        // Мы в позиции, следим за ценой
        const movementSinceEntry = ((currentPrice - pairData.entryPrice) / pairData.entryPrice) * 100;
        const profitPercent = pairData.direction === 'up' ? movementSinceEntry : -movementSinceEntry;
        const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
        const potentialProfitOrLoss = (tradeAmount * profitPercent) / 100;

        // Если цена подросла на 5% и более, активируем следование за прибылью
        if (profitPercent >= ADDITIONAL_PROFIT_THRESHOLD) {
            pairData.trailingStopActive = true;
            pairData.highestPrice = Math.max(pairData.highestPrice, currentPrice); // Обновляем самую высокую цену
            logToFile(`Цена по ${symbol} подросла на 5% или более, активировано следование за прибылью.`);
        }

        // Если активировано следование за прибылью
        if (pairData.trailingStopActive) {
            const trailingStopPercent = ((pairData.highestPrice - currentPrice) / pairData.highestPrice) * 100;

            if (trailingStopPercent >= TRAILING_STOP_THRESHOLD && potentialProfitOrLoss >= MIN_PROFIT_OR_LOSS_AMOUNT) {
                // Фиксируем прибыль при отклонении в 2% и более
                const result = fixPosition(symbol, currentPrice, profitPercent, 'profit');
                logToFile(result);
                // Сбрасываем данные и не отслеживаем пару в течение 24 часов
                resetPairData(symbol, currentPrice, now);
            }
        }

        // Если нет следования за прибылью, действуем по стандартной логике
        if (!pairData.trailingStopActive) {
            if (profitPercent >= PROFIT_THRESHOLD && potentialProfitOrLoss >= MIN_PROFIT_OR_LOSS_AMOUNT) {
                // Фиксация прибыли
                const result = fixPosition(symbol, currentPrice, profitPercent, 'profit');
                logToFile(result);
            } else if (profitPercent <= -MAX_LOSS_THRESHOLD && potentialProfitOrLoss <= -MIN_PROFIT_OR_LOSS_AMOUNT) {
                // Фиксация убытка
                const result = fixPosition(symbol, currentPrice, profitPercent, 'loss');
                logToFile(result);
            }
        }
    }
}

// Функция для фиксации сделки
function fixPosition(symbol, currentPrice, profitPercent, type) {
    const pairData = pairs[symbol];
    const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
    let result = '';

    if (type === 'profit') {
        const profit = (tradeAmount * profitPercent) / 100;
        totalProfit += profit;
        currentBalance += tradeAmount + profit;
        activeTradeAmount -= tradeAmount; // Освобождаем активный объем сделок
        result = `Прибыль по ${symbol}: ${profit.toFixed(2)} USDT, Цена закрытия: ${currentPrice.toFixed(6)}, Процент изменения: ${profitPercent.toFixed(2)}%`;
    } else if (type === 'loss') {
        const loss = (tradeAmount * Math.abs(profitPercent)) / 100;
        totalLoss += loss;
        currentBalance += tradeAmount - loss;
        activeTradeAmount -= tradeAmount; // Освобождаем активный объем сделок
        result = `Убыток по ${symbol}: ${loss.toFixed(2)} USDT, Цена закрытия: ${currentPrice.toFixed(6)}, Процент изменения: ${profitPercent.toFixed(2)}%`;
    }

    resetPairData(symbol, currentPrice, Date.now());
    return result;
}

// Сброс данных пары
function resetPairData(symbol, currentPrice, now) {
    pairs[symbol] = {
        initialPrice: currentPrice,
        initialTime: now,
        inPosition: false,
        entryPrice: null,
        direction: null,
        trailingStopActive: false,
        highestPrice: null,
    };
}

// Запуск WebSocket
startWebSocket();
