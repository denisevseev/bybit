const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

const API_KEY = 'PDMeOejlai84O41KZ5Y8cTIiF51Gimx9YgNUFzmHavPOEJbR4UYVrPP2YOE6EADH';
const SECRET_KEY = 'YvSqzPfvPDFMiyrNWgb0rwGEFCZ3q4brrFcyQIkehuGf0R3brlVvNzHjNBC88z1a';
const BASE_URL = 'https://api.binance.com';

let currentBalance = 0;
const TRADE_AMOUNT_PERCENT = 0.1;
const CHANGE_THRESHOLD = 7;
const PROFIT_THRESHOLD = 5;
const MIN_PROFIT_OR_LOSS_AMOUNT = 1; // Минимальная прибыль для трейлинг-стопа теперь 1 USDT
const STOP_LOSS_THRESHOLD = 5;  // Стоп-лосс -20% от входной цены
const MONITORING_PERIOD = 24 * 60 * 60 * 1000;  // 24 часа в миллисекундах
const MIN_VOLUME_USDT = 100000;  // Минимальный объем торгов за 24 часа для входа в сделку
const MIN_TRAILING_STOP_PROFIT = 1;  // Минимальная прибыль для трейлинг-стопа в USDT

let pairs = {};

// Функция для записи логов в файл
function logToFile(message) {
    const timestamp = new Date().toLocaleString();
    fs.appendFileSync('trades_log.log', `${timestamp} - ${message}\n`);
}

// Функция для подписания запросов к Binance API
function signQuery(query) {
    return crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
}

// Получение информации о торговой паре
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
        logToFile(`Ошибка при получении информации о символе: ${error.message}`);
        throw error;
    }
}

async function calculateMinQuantity(symbol, currentPrice) {
    try {
        const symbolInfo = await getSymbolInfo(symbol);
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const stepSize = parseFloat(lotSizeFilter.stepSize);
        const minQty = parseFloat(lotSizeFilter.minQty);
        let tradeQuantity = minQty;

        // Округляем количество по шагу лота с использованием Math.floor для корректного шага
        tradeQuantity = Math.floor(tradeQuantity / stepSize) * stepSize;

        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL') || symbolInfo.filters.find(f => f.filterType === 'NOTIONAL');
        const minNotional = minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : null;
        if (minNotional && tradeQuantity * currentPrice < minNotional) {
            tradeQuantity = minNotional / currentPrice;

            // Округляем после пересчета для минимального объема сделки
            tradeQuantity = Math.floor(tradeQuantity / stepSize) * stepSize;
        }

        const oneTenthBalance = currentBalance * TRADE_AMOUNT_PERCENT;
        const minTradeAmount = oneTenthBalance / currentPrice;
        if (tradeQuantity < minTradeAmount) {
            tradeQuantity = Math.floor(minTradeAmount / stepSize) * stepSize;
        }

        logToFile(`Рассчитанное минимальное количество для ${symbol}: ${tradeQuantity}`);
        return tradeQuantity;
    } catch (error) {
        logToFile(`Ошибка при расчете минимального количества для ${symbol}: ${error.message}`);
        throw error;
    }
}



// Получение баланса на счете
async function getBalance() {
    const endpoint = '/api/v3/account';
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = signQuery(query);
    const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;
    try {
        const response = await axios.get(url, {
            headers: { 'X-MBX-APIKEY': API_KEY },
        });
        const balances = response.data.balances;
        const usdtBalance = balances.find(b => b.asset === 'USDT');
        if (!usdtBalance) {
            throw new Error('Баланс USDT не найден');
        }
        currentBalance = parseFloat(usdtBalance.free);
        logToFile(`Баланс USDT успешно получен: ${currentBalance.toFixed(2)} USDT`);
        return currentBalance;
    } catch (error) {
        logToFile(`Ошибка при получении баланса: ${error.message}`);
        throw error;
    }
}

// Создание ордера
async function createOrder(symbol, side, quantity) {
    const endpoint = '/api/v3/order';
    const timestamp = Date.now();
    const query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    const signature = signQuery(query);
    const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;

    // Логируем попытку создания ордера
    logToFile(`Попытка создать ордер: символ = ${symbol}, сторона = ${side}, количество = ${quantity}, timestamp = ${timestamp}`);

    try {
        const response = await axios.post(url, null, {
            headers: { 'X-MBX-APIKEY': API_KEY },
        });

        logToFile(`Успешно создан ордер: ${side} ${symbol}, количество: ${quantity}`);
        return response.data;
    } catch (error) {
        // Логируем всю информацию об ошибке
        if (error.response) {
            logToFile(`Ошибка при создании ордера: ${error.response.data.msg} (код: ${error.response.data.code})`);
        } else {
            logToFile(`Ошибка при создании ордера: ${error.message}`);
        }

        // Завершаем выполнение функции, без генерации ошибки
        return null; // Или можно вернуть какое-либо значение, чтобы указать, что ордер не был создан
    }
}



// Получение количества доступного актива перед продажей
async function getAssetBalance(asset) {
    const endpoint = '/api/v3/account';
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = signQuery(query);
    const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;

    try {
        const response = await axios.get(url, {
            headers: { 'X-MBX-APIKEY': API_KEY },
        });
        const balances = response.data.balances;
        const assetBalance = balances.find(b => b.asset === asset);

        if (!assetBalance) {
            throw new Error(`Баланс актива ${asset} не найден`);
        }

        return parseFloat(assetBalance.free);
    } catch (error) {
        logToFile(`Ошибка при получении баланса актива ${asset}: ${error.message}`);
        throw error;
    }
}


async function sellAsset(symbol) {
    const asset = symbol.replace('USDT', ''); // Из символа 'BTCUSDT' выделяем актив 'BTC'
    const assetBalance = await getAssetBalance(asset);
    if (assetBalance > 0 && pairs[symbol].inPosition ) {
        await createOrder(symbol, 'SELL', assetBalance);
        logToFile(`Успешно продан актив ${symbol}, количество: ${assetBalance}`);
        return assetBalance
    } else {
        logToFile(`Недостаточно актива ${symbol} для продажи`);
    }
}




// Обработка тикеров (получение данных с биржи)
async function processTicker(ticker) {
    const symbol = ticker.s;
    const currentPrice = parseFloat(ticker.c);
    const volume24h = parseFloat(ticker.q);
    if (!symbol.endsWith('USDT') || volume24h < MIN_VOLUME_USDT) {
        return;
    }
    const now = Date.now();
    if (!pairs[symbol]) {
        pairs[symbol] = {
            initialPrice: currentPrice,
            initialTime: now,
            inPosition: false,
            entryPrice: null,
            direction: null,
            trailingStopActive: false,
            highestPrice: null,
            disableMonitoring: false,
        };
        // console.log(`Новая пара добавлена для отслеживания: ${symbol}, начальная цена: ${currentPrice}`);
        return;
    }
    const pairData = pairs[symbol];

    // Проверяем, вошли ли мы уже в сделку
    // if (pairData.inPosition) {
    //     // logToFile(`Уже находимся в позиции по паре ${symbol}`);
    //     return;
    // }

    if (now - pairData.initialTime >= MONITORING_PERIOD && !pairData.inPosition && !pairData.disableMonitoring) {
        resetPairData(symbol, currentPrice, now);
        logToFile(`Сброс данных для пары ${symbol} после 24 часов`);
    }

    // Вход в сделку при отклонении на 7% и более
    if (!pairData.inPosition) {
        const priceChangePercent = ((currentPrice - pairData.initialPrice) / pairData.initialPrice) * 100;

        //Math.abs(priceChangePercent) >= CHANGE_THRESHOLD
        if (2>1 && symbol == 'AMPUSDT') {
            let res = await createOrderWithMinCheck(symbol, 'SELL', currentPrice);
            pairData.inPosition = true;
            pairData.entryPrice = currentPrice;
            pairData.direction = priceChangePercent > 0 ? 'up' : 'down';
            pairData.highestPrice = currentPrice;
            pairData.disableMonitoring = true;
            if (res) {
                logToFile(`Вход в сделку по паре ${symbol} в направлении ${pairData.direction}. Цена открытия: ${currentPrice.toFixed(6)}`);
            }
        }
    } else {
        const movementSinceEntry = ((currentPrice - pairData.entryPrice) / pairData.entryPrice) * 100;
        const profitPercent = pairData.direction === 'up' ? movementSinceEntry : -movementSinceEntry;
        const tradeAmount = currentBalance * TRADE_AMOUNT_PERCENT;
        const potentialProfitOrLoss = (tradeAmount * profitPercent) / 100;
        const tradeQuantity = (tradeAmount / currentPrice).toFixed(6);

        // Стоп-лосс при падении на 20% и более
        //
        // profitPercent <= -STOP_LOSS_THRESHOLD
        if (symbol == 'AMPUSDT') {
            if (!pairData.inPosition) return
            await createOrder(symbol, 'SELL', tradeQuantity);
            logToFile(`Фиксация убытка по паре ${symbol} из-за достижения стоп-лосса: ${profitPercent.toFixed(2)}%`);
            resetPairData(symbol, currentPrice, now);
            return;
        }

        // Трейлинг-стоп при росте на 5% и более
        if (profitPercent >= PROFIT_THRESHOLD) {
            pairData.trailingStopActive = true;
            pairData.highestPrice = Math.max(pairData.highestPrice, currentPrice);

            const trailingStopThreshold = ((pairData.highestPrice - currentPrice) / pairData.highestPrice) * 100;

            // Динамическое изменение процента отклонения
            let dynamicTrailingStop = Math.max(1, (potentialProfitOrLoss * 0.15));
            dynamicTrailingStop = Math.max(dynamicTrailingStop, 1);  // Минимум 1 USDT
            logToFile(`Динамический процент отклонения для ${symbol}: ${dynamicTrailingStop}%`);

            if (trailingStopThreshold >= dynamicTrailingStop && potentialProfitOrLoss >= MIN_PROFIT_OR_LOSS_AMOUNT) {
                let bal = await sellAsset(symbol);
                // await createOrder(symbol, pairData.direction === 'up' ? 'SELL' : 'BUY', tradeQuantity);
                if(bal) logToFile(`Фиксация прибыли по паре ${symbol}: ${profitPercent.toFixed(2)}%`);
                resetPairData(symbol, currentPrice, now);
            }
        } else if (profitPercent <= -CHANGE_THRESHOLD && potentialProfitOrLoss <= -MIN_PROFIT_OR_LOSS_AMOUNT && pairs[symbol].inPosition) {
            await createOrder(symbol, 'SELL', tradeQuantity);
            logToFile(`Фиксация убытка по паре ${symbol}: ${profitPercent.toFixed(2)}%`);
            resetPairData(symbol, currentPrice, now);
        }
    }
}

// Сброс данных по паре
function resetPairData(symbol, currentPrice, now) {
    pairs[symbol] = {
        initialPrice: currentPrice,
        initialTime: now,
        inPosition: false,
        entryPrice: null,
        direction: null,
        trailingStopActive: false,
        highestPrice: null,
        disableMonitoring: false,
    };
    logToFile(`Сброс данных для пары ${symbol}`);
}

// Создание ордера с проверкой минимального количества
async function createOrderWithMinCheck(symbol, side, currentPrice) {
    try {
        await getBalance();
        let tradeQuantity = await calculateMinQuantity(symbol, currentPrice);
        if (tradeQuantity * currentPrice > currentBalance) {
            logToFile(`Недостаточно средств для минимального входа в ${symbol}. Требуется: ${(tradeQuantity * currentPrice).toFixed(2)} USDT, доступно: ${currentBalance.toFixed(2)} USDT`);
            return;
        }
        let res = await createOrder(symbol, side, tradeQuantity);
        logToFile(`Успешно создан ордер с минимальным количеством: ${side} ${symbol}, количество: ${tradeQuantity}`);
        return res ? true : false;
    } catch (error) {
        logToFile(`Ошибка при создании ордера для ${symbol}: ${error.message}`);
        return false;
    }
}

// Инициализация и запуск WebSocket
async function init() {
    try {
        await getBalance();
        startWebSocket();
    } catch (error) {
        logToFile(`Ошибка при инициализации: ${error.message}`);
    }
}

// Запуск WebSocket для получения данных с Binance
function startWebSocket() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr');
    ws.on('open', () => {
        logToFile('WebSocket подключен к Binance');
    });
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            tickers.forEach((ticker) => {
                processTicker(ticker);
            });
        } catch (error) {
            logToFile(`Ошибка при обработке сообщения: ${error.message}`);
        }
    });
    ws.on('error', (error) => {
        logToFile(`WebSocket ошибка: ${error.message}`);
    });
    ws.on('close', () => {
        logToFile('WebSocket соединение закрыто. Переподключение...');
        setTimeout(startWebSocket, 5000);
    });
}

init();

