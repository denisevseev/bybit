const WebSocket = require('ws');
const messages = require('./messages');

// Параметры стратегии
const INITIAL_BALANCE = 1000; // Начальный баланс в USDT
let currentBalance = INITIAL_BALANCE; // Текущий баланс
const TRADE_AMOUNT_PERCENT = 0.1; // Торгуем 10% от доступного баланса

const CHANGE_THRESHOLD = 10; // Порог изменения цены для входа в сделку (в процентах)
const PROFIT_THRESHOLD = 5; // Порог прибыли для фиксации (в процентах)
const MAX_LOSS_THRESHOLD = 20; // Порог убытка для выхода из сделки (в процентах)
const MONITORING_PERIOD = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах

// Минимальный объем торгов в USDT за 24 часа для входа в сделку
const MIN_VOLUME_USDT = 1000000;

// Объект для хранения состояния каждой валютной пары
let pairs = {};

// Переменные для учета прибыли и убытков
let totalProfit = 0; // Общая прибыль в USDT
let totalLoss = 0; // Общий убыток в USDT

messages.sendStartMessage();

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
            inPosition: false,
            entryPrice: null,
            direction: null, // 'up' или 'down'
        };
    }

    const pairData = pairs[symbol];

    // Проверяем, прошло ли 24 часа с момента начала отслеживания
    if (now - pairData.initialTime >= MONITORING_PERIOD) {
        resetPairData(symbol, currentPrice, now);
        console.log(`Сброс данных для пары ${symbol} после 24 часов.`);
    }

    // Если мы не в позиции
    if (!pairData.inPosition) {
        const priceChangePercent = ((currentPrice - pairData.initialPrice) / pairData.initialPrice) * 100;

        // Проверяем, можем ли мы войти в сделку
        if (Math.abs(priceChangePercent) >= CHANGE_THRESHOLD && currentBalance >= INITIAL_BALANCE * TRADE_AMOUNT_PERCENT) {
            // Входим в сделку
            const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
            currentBalance -= tradeAmount;
            pairData.inPosition = true;
            pairData.entryPrice = currentPrice;
            pairData.direction = priceChangePercent > 0 ? 'up' : 'down';

            // Отправляем уведомление о входе в сделку
            messages.sendTradeEntryMessage(symbol, pairData.direction, currentPrice);

            console.log(`Вход в сделку по паре ${symbol} в направлении ${pairData.direction}`);

            // Отправляем список открытых сделок
            sendOpenTradesUpdate();
        }
    } else {
        // Мы в позиции, следим за ценой
        const movementSinceEntry = ((currentPrice - pairData.entryPrice) / pairData.entryPrice) * 100;
        const profitPercent = pairData.direction === 'up' ? movementSinceEntry : -movementSinceEntry;

        // Проверяем на фиксацию прибыли или убытка
        if (profitPercent >= PROFIT_THRESHOLD) {
            // Фиксируем прибыль
            const profit = (currentBalance * TRADE_AMOUNT_PERCENT * PROFIT_THRESHOLD) / 100;
            totalProfit += profit;
            currentBalance += (currentBalance * TRADE_AMOUNT_PERCENT) + profit;

            messages.sendProfitMessage(symbol, profit, PROFIT_THRESHOLD, currentPrice, totalProfit, totalLoss);

            // Сбрасываем данные для этой пары
            resetPairData(symbol, currentPrice, now);
            console.log(`Фиксация прибыли по ${symbol}. Сбрасываем данные и начинаем новый отсчет.`);

            // Отправляем список открытых сделок
            sendOpenTradesUpdate();
        } else if (profitPercent <= -MAX_LOSS_THRESHOLD) {
            // Фиксируем убыток
            const loss = (currentBalance * TRADE_AMOUNT_PERCENT * MAX_LOSS_THRESHOLD) / 100;
            totalLoss += loss;
            currentBalance += (currentBalance * TRADE_AMOUNT_PERCENT) - loss;

            messages.sendLossMessage(symbol, loss, currentPrice, totalProfit, totalLoss);

            // Сбрасываем данные для этой пары
            resetPairData(symbol, currentPrice, now);
            console.log(`Фиксация убытка по ${symbol}. Сбрасываем данные и начинаем новый отсчет.`);

            // Отправляем список открытых сделок
            sendOpenTradesUpdate();
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

// Функция для отправки списка открытых сделок
function sendOpenTradesUpdate() {
    let openTrades = Object.keys(pairs)
        .filter(symbol => pairs[symbol].inPosition)
        .map(symbol => {
            const pairData = pairs[symbol];
            const movementSinceEntry = ((pairData.entryPrice - pairData.initialPrice) / pairData.initialPrice) * 100;
            const profitPercent = pairData.direction === 'up' ? movementSinceEntry : -movementSinceEntry;
            const directionText = pairData.direction === 'up' ? 'Лонг' : 'Шорт';
            return `${symbol.replace('USDT', '/USDT')}: Цена входа: ${pairData.entryPrice.toFixed(2)}, ${directionText}, Текущий % изменения: ${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%`;
        });

    if (openTrades.length > 0) {
        const message = `
📊 <b>Открытые сделки:</b>\n${openTrades.join('\n')}
`;
        messages.sendUpdateMessageList(message);
    } else {
        messages.sendUpdateMessageList('ℹ️ <b>Нет открытых сделок на данный момент.</b>');
    }
}

startWebSocket();
