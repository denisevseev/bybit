const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// Инициализация бота с вашим токеном и включенным polling
const bot = new TelegramBot('6898599983:AAGCokpNt5YxG6_DmcnCOju4UHKJYOE7UlE');
const chatId = '5761109418';


// Параметры стратегии
const INITIAL_BALANCE = 1000; // Начальный баланс в USDT
const TRADE_AMOUNT = 100; // Сумма сделки в USDT

const CHANGE_THRESHOLD = 10; // Порог изменения цены для входа в сделку (в процентах)
const MIN_PROFIT_THRESHOLD = 5; // Минимальная прибыль для начала трейлинг-стопа (в процентах)
const TRAILING_STOP_PERCENT = 3; // Отклонение трейлинг-стопа от максимальной цены (в процентах)
const MAX_LOSS_THRESHOLD = 20; // Порог убытка для выхода из сделки (в процентах)
const MONITORING_PERIOD = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах

// Объект для хранения состояния каждой валютной пары
let pairs = {};

// Переменные для учета прибыли и убытков
let totalProfit = 0; // Общая прибыль в USDT
let totalLoss = 0; // Общий убыток в USDT

bot.sendMessage(chatId, '---------НОВОЕ НАЧАЛО--------').catch((error) => {
    console.error('Ошибка при отправке сообщения в Telegram:', error.message);
});

// Функция для запуска WebSocket соединения
function startWebSocket() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr');

    ws.on('open', function open() {
        console.log('WebSocket подключен к Binance');
    });

    ws.on('message', function incoming(data) {
        try {
            const tickers = JSON.parse(data);

            tickers.forEach((ticker) => {
                processTicker(ticker);
            });
        } catch (error) {
            console.error('Ошибка при обработке сообщения:', error.message);
        }
    });

    ws.on('error', function error(error) {
        console.error('WebSocket ошибка:', error.message);
    });

    ws.on('close', function close() {
        console.log('WebSocket соединение закрыто. Попытка переподключения...');

        // Переподключение после задержки
        setTimeout(() => {
            startWebSocket();
        }, 5000); // 5 секунд
    });
}

// Функция для обработки тикера
function processTicker(ticker) {
    const symbol = ticker.s;
    const currentPrice = parseFloat(ticker.c);

    // Фильтруем только пары с USDT
    if (!symbol.endsWith('USDT')) {
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
            maxPrice: null,
            direction: null, // 'up' или 'down'
        };
    }

    const pairData = pairs[symbol];

    // Проверяем, прошло ли 24 часа с момента начала отслеживания
    if (now - pairData.initialTime >= MONITORING_PERIOD) {
        // Сбрасываем данные и начинаем новый отсчет
        resetPairData(symbol, currentPrice, now);
        console.log(`Сброс данных для пары ${symbol} после 24 часов.`);
    }

    // Если мы не в позиции
    if (!pairData.inPosition) {
        const priceChangePercent = ((currentPrice - pairData.initialPrice) / pairData.initialPrice) * 100;

        if (Math.abs(priceChangePercent) >= CHANGE_THRESHOLD) {
            // Входим в сделку
            pairData.inPosition = true;
            pairData.entryPrice = currentPrice;
            pairData.maxPrice = currentPrice;
            pairData.direction = priceChangePercent > 0 ? 'up' : 'down';

            // Отправляем уведомление о входе в сделку
            const directionText = pairData.direction === 'up' ? '📈 Покупка' : '📉 Продажа';
            const formattedSymbol = symbol.replace('USDT', '/USDT');
            const message = `
<b>Вход в сделку (${directionText}):</b> ${formattedSymbol}
Цена входа: <b>${currentPrice}</b>
<a href="https://www.binance.com/ru/trade/${formattedSymbol}?layout=pro">Открыть в Binance</a>
`;
            bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
                console.error('Ошибка при отправке сообщения в Telegram:', error.message);
            });

            console.log(`Вход в сделку по паре ${symbol} в направлении ${pairData.direction}`);
        }
    } else {
        // Мы в позиции, следим за ценой
        const movementSinceEntry = ((currentPrice - pairData.entryPrice) / pairData.entryPrice) * 100;

        // Обновляем максимальную цену в зависимости от направления
        if (pairData.direction === 'up' && currentPrice > pairData.maxPrice) {
            pairData.maxPrice = currentPrice;
        } else if (pairData.direction === 'down' && currentPrice < pairData.maxPrice) {
            pairData.maxPrice = currentPrice;
        }

        // Рассчитываем отклонение от максимальной цены
        let deviationPercent = 0;
        if (pairData.direction === 'up') {
            deviationPercent = ((pairData.maxPrice - currentPrice) / pairData.maxPrice) * 100;
        } else if (pairData.direction === 'down') {
            deviationPercent = ((currentPrice - pairData.maxPrice) / pairData.maxPrice) * 100;
        }

        // Проверяем на фиксацию прибыли или убытка
        if (pairData.direction === 'up') {
            if (movementSinceEntry >= MIN_PROFIT_THRESHOLD && deviationPercent >= TRAILING_STOP_PERCENT) {
                // Фиксируем прибыль
                const profitPercent = ((pairData.maxPrice - pairData.entryPrice) / pairData.entryPrice) * 100 - TRAILING_STOP_PERCENT;
                const profit = (TRADE_AMOUNT * profitPercent) / 100;
                totalProfit += profit;

                const formattedSymbol = symbol.replace('USDT', '/USDT');
                const message = `
✅ <b>Сделка закрыта с прибылью!</b>
Пара: ${formattedSymbol}
Прибыль: <b>${profit.toFixed(2)} USDT (${profitPercent.toFixed(2)}%)</b>
Текущая цена: <b>${currentPrice}</b>
Общая прибыль: <b>${totalProfit.toFixed(2)} USDT</b>
Общий убыток: <b>${totalLoss.toFixed(2)} USDT</b>
<a href="https://www.binance.com/ru/trade/${formattedSymbol}?layout=pro">Открыть в Binance</a>
`;
                bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
                    console.error('Ошибка при отправке сообщения в Telegram:', error.message);
                });

                // После фиксации прибыли продолжаем мониторинг только в противоположном направлении
                pairData.inPosition = false;
                pairData.initialPrice = currentPrice;
                pairData.initialTime = now;
                pairData.direction = 'down'; // Теперь отслеживаем только продажи
                console.log(`Фиксация прибыли по ${symbol}. Теперь отслеживаем движение вниз.`);
            } else if (movementSinceEntry <= -MAX_LOSS_THRESHOLD) {
                // Фиксируем убыток
                const loss = (TRADE_AMOUNT * MAX_LOSS_THRESHOLD) / 100;
                totalLoss += loss;

                const formattedSymbol = symbol.replace('USDT', '/USDT');
                const message = `
❌ <b>Сделка закрыта с убытком.</b>
Пара: ${formattedSymbol}
Убыток: <b>${loss.toFixed(2)} USDT (${MAX_LOSS_THRESHOLD}%)</b>
Текущая цена: <b>${currentPrice}</b>
Общая прибыль: <b>${totalProfit.toFixed(2)} USDT</b>
Общий убыток: <b>${totalLoss.toFixed(2)} USDT</b>
<a href="https://www.binance.com/ru/trade/${formattedSymbol}?layout=pro">Открыть в Binance</a>
`;
                bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
                    console.error('Ошибка при отправке сообщения в Telegram:', error.message);
                });

                // После фиксации убытка сбрасываем данные
                resetPairData(symbol, currentPrice, now);
                console.log(`Фиксация убытка по ${symbol}. Сбрасываем данные и начинаем новый отсчет.`);
            }
        } else if (pairData.direction === 'down') {
            if (movementSinceEntry <= -MIN_PROFIT_THRESHOLD && deviationPercent >= TRAILING_STOP_PERCENT) {
                // Фиксируем прибыль
                const profitPercent = ((pairData.entryPrice - pairData.maxPrice) / pairData.entryPrice) * 100 - TRAILING_STOP_PERCENT;
                const profit = (TRADE_AMOUNT * profitPercent) / 100;
                totalProfit += profit;

                const formattedSymbol = symbol.replace('USDT', '/USDT');
                const message = `
✅ <b>Сделка закрыта с прибылью!</b>
Пара: ${formattedSymbol}
Прибыль: <b>${profit.toFixed(2)} USDT (${profitPercent.toFixed(2)}%)</b>
Текущая цена: <b>${currentPrice}</b>
Общая прибыль: <b>${totalProfit.toFixed(2)} USDT</b>
Общий убыток: <b>${totalLoss.toFixed(2)} USDT</b>
<a href="https://www.binance.com/ru/trade/${formattedSymbol}?layout=pro">Открыть в Binance</a>
`;
                bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
                    console.error('Ошибка при отправке сообщения в Telegram:', error.message);
                });

                // После фиксации прибыли продолжаем мониторинг только в противоположном направлении
                pairData.inPosition = false;
                pairData.initialPrice = currentPrice;
                pairData.initialTime = now;
                pairData.direction = 'up'; // Теперь отслеживаем только покупки
                console.log(`Фиксация прибыли по ${symbol}. Теперь отслеживаем движение вверх.`);
            } else if (movementSinceEntry >= MAX_LOSS_THRESHOLD) {
                // Фиксируем убыток
                const loss = (TRADE_AMOUNT * MAX_LOSS_THRESHOLD) / 100;
                totalLoss += loss;

                const formattedSymbol = symbol.replace('USDT', '/USDT');
                const message = `
❌ <b>Сделка закрыта с убытком.</b>
Пара: ${formattedSymbol}
Убыток: <b>${loss.toFixed(2)} USDT (${MAX_LOSS_THRESHOLD}%)</b>
Текущая цена: <b>${currentPrice}</b>
Общая прибыль: <b>${totalProfit.toFixed(2)} USDT</b>
Общий убыток: <b>${totalLoss.toFixed(2)} USDT</b>
<a href="https://www.binance.com/ru/trade/${formattedSymbol}?layout=pro">Открыть в Binance</a>
`;
                bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((error) => {
                    console.error('Ошибка при отправке сообщения в Telegram:', error.message);
                });

                // После фиксации убытка сбрасываем данные
                resetPairData(symbol, currentPrice, now);
                console.log(`Фиксация убытка по ${symbol}. Сбрасываем данные и начинаем новый отсчет.`);
            }
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
        maxPrice: null,
        direction: null,
    };
}

startWebSocket();
