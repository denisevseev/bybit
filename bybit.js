const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

// Ваши API ключи
const API_KEY = 'PDMeOejlai84O41KZ5Y8cTIiF51Gimx9YgNUFzmHavPOEJbR4UYVrPP2YOE6EADH';
const SECRET_KEY = 'YvSqzPfvPDFMiyrNWgb0rwGEFCZ3q4brrFcyQIkehuGf0R3brlVvNzHjNBC88z1a';

// URL Binance API
const BASE_URL = 'https://api.binance.com';

// Параметры стратегии
let currentBalance = 0; // Текущий баланс (будет получен из API)
let activeTradeAmount = 0; // Сумма активных сделок
const TRADE_AMOUNT_PERCENT = 0.1; // Торгуем 10% от доступного баланса

const CHANGE_THRESHOLD = 7; // Порог изменения цены для входа в сделку (в процентах)
const PROFIT_THRESHOLD = 5; // Порог прибыли для включения следования за прибылью (в процентах)
const TRAILING_STOP_THRESHOLD = 1; // Порог отклонения для фиксации прибыли (в процентах)
const MIN_PROFIT_OR_LOSS_AMOUNT = 4; // Минимальная прибыль или убыток в USDT для фиксации

const MONITORING_PERIOD = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах
const MIN_VOLUME_USDT = 100000; // Минимальный объем торгов для входа в сделку

// Объект для хранения состояния каждой валютной пары
let pairs = {};

// Функция для записи в лог-файл
function logToFile(message) {
    const timestamp = new Date().toLocaleString();
    fs.appendFileSync('trades_log.txt', `${timestamp} - ${message}\n`);
}

// Функция для создания подписи запроса (Binance требует HMAC SHA256)
function signQuery(query) {
    return crypto
        .createHmac('sha256', SECRET_KEY)
        .update(query)
        .digest('hex');
}

// Функция для получения информации о торговой паре (ограничения, такие как LOT_SIZE и MIN_NOTIONAL)
async function getSymbolInfo(symbol) {
    const endpoint = '/api/v3/exchangeInfo';
    const url = `${BASE_URL}${endpoint}`;

    try {
        const response = await axios.get(url);
        const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
        if (!symbolInfo) {
            throw new Error(`Информация о паре ${symbol} не найдена.`);
        }
        return symbolInfo;
    } catch (error) {
        console.error('Ошибка при получении информации о символе:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// Функция для проверки и корректировки количества ордера по LOT_SIZE и MIN_NOTIONAL
async function adjustQuantityToLotSize(symbol, quantity, currentPrice) {
    try {
        const symbolInfo = await getSymbolInfo(symbol);

        // Находим фильтр LOT_SIZE
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minQty = parseFloat(lotSizeFilter.minQty);
        const maxQty = parseFloat(lotSizeFilter.maxQty);
        const stepSize = parseFloat(lotSizeFilter.stepSize);
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        const minNotional = minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : null;

        // Округляем количество до ближайшего допустимого шага
        quantity = Math.floor(quantity / stepSize) * stepSize;

        // Проверка на минимальный объем сделки (если фильтр MIN_NOTIONAL присутствует)
        if (minNotional && quantity * currentPrice < minNotional) {
            throw new Error(`Объем сделки меньше минимального допустимого для пары ${symbol} (${minNotional} USDT).`);
        }

        // Проверка на минимальное количество
        if (quantity < minQty) {
            throw new Error(`Количество меньше минимального допустимого для пары ${symbol} (${minQty}).`);
        } else if (quantity > maxQty) {
            quantity = maxQty; // Если больше максимума, округляем до максимума
        }

        console.log(`Откорректированное количество для ${symbol}: ${quantity}`);
        logToFile(`Откорректированное количество для ${symbol}: ${quantity}`);
        return quantity;
    } catch (error) {
        console.error('Ошибка при корректировке количества:', error.message);
        throw error;
    }
}

// Функция для получения баланса USDT с Binance
async function getBalance() {
    const endpoint = '/api/v3/account';
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = signQuery(query);
    const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;

    try {
        console.log(`Запрос баланса: GET ${url}`);

        // Выполняем запрос
        const response = await axios.get(url, {
            headers: {
                'X-MBX-APIKEY': API_KEY,
            },
        });

        // Обрабатываем ответ и ищем баланс USDT
        const balances = response.data.balances;
        const usdtBalance = balances.find(b => b.asset === 'USDT');
        if (!usdtBalance) {
            throw new Error('Баланс USDT не найден');
        }

        currentBalance = parseFloat(usdtBalance.free);
        logToFile(`Баланс USDT успешно получен: ${currentBalance.toFixed(2)} USDT`);
        return currentBalance;
    } catch (error) {
        console.error('Ошибка при получении баланса:', error.response ? error.response.data : error.message);
        logToFile(`Ошибка при получении баланса: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        throw error; // Прерываем выполнение, если баланс не удалось получить
    }
}

// Функция для отправки ордера на Binance (покупка/продажа)
async function createOrder(symbol, side, quantity) {
    const endpoint = '/api/v3/order';
    const timestamp = Date.now();
    const query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    const signature = signQuery(query);
    const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;

    try {
        console.log(`Отправка ордера: ${side} ${symbol}, количество: ${quantity}`);

        // Отправляем POST запрос
        const response = await axios.post(url, null, {
            headers: {
                'X-MBX-APIKEY': API_KEY,
            },
        });

        logToFile(`Успешно создан ордер: ${side} ${symbol}, количество: ${quantity}`);
        return response.data;
    } catch (error) {
        console.error('Ошибка при создании ордера:', error.response ? error.response.data : error.message);
        logToFile(`Ошибка при создании ордера: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        throw error; // Прерываем выполнение, если не удается создать ордер
    }
}

// Функция для создания ордера с проверкой минимального количества и логированием ошибок
async function createOrderWithMinCheck(symbol, side, currentPrice) {
    try {
        // Пытаемся войти в сделку с 1/10 от доступного баланса
        const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
        let tradeQuantity = (tradeAmount / currentPrice).toFixed(6);  // Количество актива на 10% баланса

        // Пробуем создать ордер
        try {
            await createOrder(symbol, side, tradeQuantity);
            logToFile(`Успешно создан ордер с 1/10 баланса: ${side} ${symbol}, количество: ${tradeQuantity}`);
        } catch (error) {
            // Если ошибка связана с минимальным количеством (LOT_SIZE), пробуем минимальное количество
            if (error.response && error.response.data && error.response.data.code === -1013 && error.response.data.msg.includes("LOT_SIZE")) {
                logToFile(`Ошибка LOT_SIZE для ордера ${symbol}. Пробуем минимальное количество.`);

                // Получаем минимальное количество через фильтры пары
                tradeQuantity = await adjustQuantityToLotSize(symbol, tradeQuantity, currentPrice);

                // Если минимальное количество превышает доступные средства, пропускаем сделку
                if (tradeQuantity * currentPrice > currentBalance) {
                    throw new Error(`Недостаточно средств для минимального входа в ${symbol}. Требуется: ${tradeQuantity * currentPrice}, доступно: ${currentBalance}`);
                }

                // Пробуем снова создать ордер с минимальным количеством
                try {
                    await createOrder(symbol, side, tradeQuantity);
                    logToFile(`Успешно создан ордер с минимальным количеством: ${side} ${symbol}, количество: ${tradeQuantity}`);
                } catch (finalError) {
                    // Если снова ошибка, логируем как неудачную попытку и объект ошибки
                    logToFile(`Ошибка при повторной попытке создания ордера для ${symbol} с количеством: ${tradeQuantity}`);
                    logToFile(`Ошибка объекта: ${JSON.stringify(finalError.response ? finalError.response.data : finalError.message)}`);
                }
            } else {
                // Если ошибка не связана с LOT_SIZE, просто логируем её
                throw error;
            }
        }
    } catch (error) {
        console.error(`Ошибка при создании ордера для ${symbol}: ${error.message}`);
        logToFile(`Ошибка при создании ордера для ${symbol}: ${error.message}`);
    }
}

// Функция для обработки тикера
async function processTicker(ticker) {
    const symbol = ticker.s;
    const currentPrice = parseFloat(ticker.c);
    const volume24h = parseFloat(ticker.q); // Объем торгов за 24 часа в USDT

    // Фильтруем только пары с USDT и проверяем объем торгов
    if (!symbol.endsWith('USDT') || volume24h < MIN_VOLUME_USDT) {
        return; // Пропускаем пары с недостаточным объемом торгов
    }

    const now = Date.now();

    // Инициализируем данные для пары, если это первая встреча
    if (!pairs[symbol]) {
        pairs[symbol] = {
            initialPrice: currentPrice,
            initialTime: now,
            inPosition: false,
            entryPrice: null,
            direction: null,
            trailingStopActive: false,
            highestPrice: null,
            disableMonitoring: false, // Отключение таймера сброса
        };
        logToFile(`Новая пара добавлена для отслеживания: ${symbol}, начальная цена: ${currentPrice}`);
        return;
    }

    const pairData = pairs[symbol];

    // Проверяем, прошло ли 24 часа с момента начала отслеживания и таймер сброса включен
    if (now - pairData.initialTime >= MONITORING_PERIOD && !pairData.inPosition && !pairData.disableMonitoring) {
        resetPairData(symbol, currentPrice, now);
        console.log(`Сброс данных для пары ${symbol} после 24 часов`);
        logToFile(`Сброс данных для пары ${symbol} после 24 часов`);
    }

    // Если мы не в позиции
    if (!pairData.inPosition) {
        const priceChangePercent = ((currentPrice - pairData.initialPrice) / pairData.initialPrice) * 100;

        // Входим в сделку, только если цена отклонилась на 7% и более
        if (Math.abs(priceChangePercent) >= CHANGE_THRESHOLD) {
            await createOrderWithMinCheck(symbol, priceChangePercent > 0 ? 'BUY' : 'SELL', currentPrice);
            pairData.inPosition = true;
            pairData.entryPrice = currentPrice;
            pairData.direction = priceChangePercent > 0 ? 'up' : 'down';
            pairData.highestPrice = currentPrice;
            pairData.disableMonitoring = true; // Отключаем сброс для этой пары

            logToFile(`Вход в сделку по паре ${symbol} в направлении ${pairData.direction}. Цена открытия: ${currentPrice.toFixed(6)}`);
        }
    } else {
        // Логика выхода из позиции: следим за прибылью или убытком
        const movementSinceEntry = ((currentPrice - pairData.entryPrice) / pairData.entryPrice) * 100;
        const profitPercent = pairData.direction === 'up' ? movementSinceEntry : -movementSinceEntry;
        const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
        const potentialProfitOrLoss = (tradeAmount * profitPercent) / 100;
        const tradeQuantity = (tradeAmount / currentPrice).toFixed(6);

        // Следим за прибылью, если цена выросла на 5% и более
        if (profitPercent >= PROFIT_THRESHOLD) {
            pairData.trailingStopActive = true;
            pairData.highestPrice = Math.max(pairData.highestPrice, currentPrice); // Обновляем самую высокую цену

            // Если цена отклоняется на 2% и более в противоположную сторону, но мы ещё в прибыли
            const trailingStopPercent = ((pairData.highestPrice - currentPrice) / pairData.highestPrice) * 100;
            if (trailingStopPercent >= TRAILING_STOP_THRESHOLD && potentialProfitOrLoss >= MIN_PROFIT_OR_LOSS_AMOUNT) {
                await createOrder(symbol, pairData.direction === 'up' ? 'SELL' : 'BUY', tradeQuantity);
                logToFile(`Фиксация прибыли по паре ${symbol}: ${profitPercent.toFixed(2)}%`);
                resetPairData(symbol, currentPrice, now);
            }
        } else if (profitPercent <= -CHANGE_THRESHOLD && potentialProfitOrLoss <= -MIN_PROFIT_OR_LOSS_AMOUNT) {
            // Фиксация убытка, если цена ушла ниже порога
            await createOrder(symbol, pairData.direction === 'up' ? 'SELL' : 'BUY', tradeQuantity);
            logToFile(`Фиксация убытка по паре ${symbol}: ${profitPercent.toFixed(2)}%`);
            resetPairData(symbol, currentPrice, now);
        }
    }
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
        disableMonitoring: false, // Сбрасываем таймер сброса
    };
    logToFile(`Сброс данных для пары ${symbol}`);
}

// Инициализация - получение баланса и запуск WebSocket
async function init() {
    try {
        await getBalance();
        startWebSocket();
    } catch (error) {
        console.error('Ошибка при инициализации:', error.message);
        logToFile(`Ошибка при инициализации: ${error.message}`);
    }
}

// Функция для запуска WebSocket соединения
function startWebSocket() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr');

    ws.on('open', () => {
        console.log('WebSocket подключен к Binance');
        logToFile('WebSocket подключен к Binance');
    });

    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            tickers.forEach((ticker) => {
                processTicker(ticker);
            });
        } catch (error) {
            console.error('Ошибка при обработке сообщения:', error.message);
            logToFile(`Ошибка при обработке сообщения: ${error.message}`);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket ошибка:', error.message);
        logToFile(`WebSocket ошибка: ${error.message}`);
    });

    ws.on('close', () => {
        console.log('WebSocket соединение закрыто. Переподключение...');
        logToFile('WebSocket соединение закрыто. Переподключение...');
        setTimeout(startWebSocket, 5000); // Переподключение через 5 секунд
    });
}

init();
