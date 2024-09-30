const WebSocket = require('ws');
const fs = require('fs');

// Параметры стратегии
const INITIAL_BALANCE = 1000; // Начальный баланс в USDT
let currentBalance = INITIAL_BALANCE; // Текущий баланс
const TRADE_AMOUNT_PERCENT = 0.1; // Торгуем 10% от доступного баланса

const CHANGE_THRESHOLD = 1; // Порог изменения цены для входа в сделку (в процентах)
const PROFIT_THRESHOLD = 2; // Порог прибыли для фиксации (в процентах)
const MAX_LOSS_THRESHOLD = 20; // Порог убытка для выхода из сделки (в процентах)
const MIN_PROFIT_AMOUNT = 4; // Минимальная прибыль для фиксации сделки (в USDT)
const MONITORING_PERIOD = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах

// Минимальный объем торгов в USDT за 24 часа для входа в сделку
const MIN_VOLUME_USDT = 1000000;

// Объект для хранения состояния каждой валютной пары
let pairs = {};

// Переменные для учета прибыли и убытков
let totalProfit = 0; // Общая прибыль в USDT
let totalLoss = 0; // Общий убыток в USDT

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
        logToFile(`Сброс данных для пары ${symbol} после 24 часов.`);
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

            // Логируем вход в сделку
            logToFile(`Вход в сделку по паре ${symbol} в направлении ${pairData.direction}. Цена открытия: ${currentPrice.toFixed(6)}`);
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

            // Логируем прибыль с указанием цен открытия и закрытия, а также процента изменения
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

// Запускаем WebSocket для мониторинга
startWebSocket();
