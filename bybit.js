const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com/stream';
const API_KEY = 'R7nkPfaYEmtCYEgE4kCQQy4WHdkOUOTgyDKHIcvyBP3qVEWCkDIhUuOHYUjhQUG5';
const SECRET_KEY = 'EZBzLuzGFuNaK3xiRt7bcWmkqKdqJdfhwEtP5p9JThemrRj10PD0GvUvNXAxXMa7';

// Параметры стратегии
const PERCENT_CHANGE = 0.07;   // 7% изменение цены для обнаружения
const WAIT_TIME = 2;    // 5 секунд ожидания после изменения цены
const MAX_CORRECTION = 0.50;   // 80% максимальная коррекция цены во время ожидания (очень большое значение!)
const PROFIT_TARGET = 0.03;    // 3% цель по прибыли
const LOSS_THRESHOLD = 0.10;   // 10% изменение против позиции для фиксации убытка
const CORRECTION_AFTER_PROFIT = 0.01; // 1% коррекция после достижения прибыли
const LOSS_THRESHOLD_FOR_RECOVERY = 0.05; // 5% порог убытка для отслеживания возврата к точке входа

let accountBalance = 0;
let openPositions = {};
let priceUpdates = {};
let potentialEntries = {};
let priceHistory = {};
let inProgress = {};
let lastLoggedPercentChange = {}; 


const logFile = path.join(__dirname, 'trade.log');

function log(message) {
    // Получаем московское время
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
    console.log(message)
}

async function checkExistingPosition(symbol) {
    const params = {
        timestamp: Date.now(),
        recvWindow: 5000
    };
    const query = signQuery(params);

    try {
        const response = await axios.get(`${BASE_URL}/fapi/v2/positionRisk?${query}`, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });

        const position = response.data.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (position) {
            log(`Уже есть открытая позиция по ${symbol}: Количество ${position.positionAmt}`);
            return true;
        }
    } catch (error) {
        log(`Ошибка при проверке существующей позиции по ${symbol}: ${error.message}`);
    }
    return false;
}

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
            log(`Символ ${symbol} не найден.`);
            return null;
        }

        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotionalFilter = symbolInfo.filters.find(f => 
            f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL'
        );

        return {
            minQty: parseFloat(lotSizeFilter?.minQty || 0), // Обработка отсутствия minQty
            stepSize: parseFloat(lotSizeFilter?.stepSize || 0), // Обработка отсутствия stepSize
            minNotional: parseFloat(minNotionalFilter?.minNotional || minNotionalFilter?.notional || 0) // Проверка обоих свойств
        };
    } catch (error) {
        log(`Ошибка получения информации о символе ${symbol}: ${error.message}`);
        throw error;
    }
}


function roundStepSize(quantity, stepSize) {
    const precision = Math.round(-Math.log10(stepSize));
    const qty = Math.floor(quantity / stepSize) * stepSize;
    return parseFloat(qty.toFixed(precision));
}

async function getAccountBalance() {
    log('Получение баланса аккаунта');
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
        accountBalance = usdtBalance ? parseFloat(usdtBalance.availableBalance) : 0;
        log(`Баланс аккаунта: ${usdtBalance.walletBalance}, Доступно для торговли: ${accountBalance}`);
    } catch (error) {
        log(`Ошибка при получении баланса аккаунта: ${error.response ? error.response.data.msg : error.message}`);
    }
}

async function getSymbolList() {
    log('Получение списка символов');
    try {
        const response = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
        const symbols = response.data.symbols
            .filter(symbol => symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING')
            .map(symbol => symbol.symbol);
        log(`Список символов загружен: ${symbols.length} символов`);
        return symbols;
    } catch (error) {
        log(`Ошибка при получении списка символов: ${error.message}`);
        return [];
    }
}

async function openPosition(symbol, side) {
    log(`Проверяем наличие существующей позиции по ${symbol}...`);

    const hasPosition = await checkExistingPosition(symbol);
    if (hasPosition) {
        log(`Позиция по ${symbol} уже открыта. Пропускаем открытие.`);
        return;
    }
    

    log(`Attempting to open position for ${symbol} с направлением ${side}`);
    if (accountBalance === 0) {
        log(`Недостаточно средств для открытия позиции по ${symbol}`);
        return;
    }

    const price = priceUpdates[symbol];
    if (!price) {
        log(`Нет текущей цены для ${symbol}`);
        return;
    }

    let orderValue = Math.max(accountBalance / 15, 100);
    const { minQty, stepSize } = await getSymbolInfo(symbol);

    let minQuantity = 100 / price;
    minQuantity = Math.ceil(minQuantity / stepSize) * stepSize;
    minQuantity = Math.max(minQuantity, minQty);

    let quantity = orderValue / price;
    quantity = roundStepSize(quantity, stepSize);

    if (quantity < minQuantity) {
        quantity = minQuantity;
        orderValue = quantity * price;
    }

    if (orderValue > accountBalance) {
        log(`Недостаточно средств для открытия позиции по ${symbol}.`);
        return;
    }

    log(`Открываем позицию по ${symbol}: Количество ${quantity}, Сумма ${orderValue.toFixed(2)} USDT`);

    const params = {
        symbol,
        side,
        type: 'MARKET',
        quantity,
        recvWindow: 5000,
        timestamp: Date.now()
    };
    const query = signQuery(params);



    if(!hasPosition){
        try {
            const response = await axios.post(`${BASE_URL}/fapi/v1/order?${query}`, null, {
                headers: { 'X-MBX-APIKEY': API_KEY }
            });
            log(`Позиция открыта по ${symbol}: Направление ${side}, Количество ${quantity}, Цена входа ${price}`);
            openPositions[symbol] = {
                side,
                entryPrice: price,
                quantity,
                openTime: Date.now(),
                profitTargetReached: false,
                lossThresholdReached: false,
                peakPrice: price
            };
            accountBalance -= orderValue;
        } catch (error) {
            log(`Ошибка при открытии позиции по ${symbol}: ${error.response ? error.response.data.msg : error.message}`);
        }
    }
}

async function closePosition(symbol) {
    log(`Пытаемся закрыть позицию по ${symbol}`);
    
    try {
        // Запрос текущей позиции на фьючерсах
        const params = {
            timestamp: Date.now(),
            recvWindow: 5000
        };
        const query = signQuery(params);

        const response = await axios.get(`${BASE_URL}/fapi/v2/positionRisk?${query}`, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });

        // Получаем количество монет по символу
        const positionData = response.data.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (!positionData) {
            log(`Нет открытой позиции по ${symbol}`);
            return;
        }

        const positionAmt = Math.abs(parseFloat(positionData.positionAmt)); // Количество монет
        const side = parseFloat(positionData.positionAmt) > 0 ? 'SELL' : 'BUY'; // Определяем направление закрытия

        log(`Закрываем позицию по ${symbol}. Количество: ${positionAmt}, Направление: ${side}`);

        const paramsClose = {
            symbol,
            side,
            type: 'MARKET',
            quantity: positionAmt,
            recvWindow: 5000,
            timestamp: Date.now()
        };
        const queryClose = signQuery(paramsClose);

        // Запрос на закрытие позиции
        const closeResponse = await axios.post(`${BASE_URL}/fapi/v1/order?${queryClose}`, null, {
            headers: { 'X-MBX-APIKEY': API_KEY }
        });

        log(`Позиция по ${symbol} успешно закрыта. Направление: ${side}, Количество: ${positionAmt}`);
        
        // Обновляем локальные данные
        delete openPositions[symbol];
        delete potentialEntries[symbol];
        delete priceHistory[symbol];
        delete priceUpdates[symbol];

    } catch (error) {
        log(`Ошибка при закрытии позиции по ${symbol}: ${error.response ? error.response.data.msg : error.message}`);
    }
}

function handleOpenPosition(symbol, currentPrice) {
    const position = openPositions[symbol];
    const entryPrice = position.entryPrice;
    const positionChange = (currentPrice - entryPrice) / entryPrice;

    const isProfitable = (position.side === 'BUY' && positionChange > 0) || (position.side === 'SELL' && positionChange < 0);
    const isLosing = (position.side === 'BUY' && positionChange < 0) || (position.side === 'SELL' && positionChange > 0);

    if (isProfitable) {
        if (!position.peakPrice || 
            (position.side === 'BUY' && currentPrice > position.peakPrice) || 
            (position.side === 'SELL' && currentPrice < position.peakPrice)) {
            position.peakPrice = currentPrice;
        }
    }

    if (isLosing && Math.abs(positionChange) >= LOSS_THRESHOLD_FOR_RECOVERY && !position.lossThresholdReached) {
        position.lossThresholdReached = true;
        log(`Порог убытка в ${(LOSS_THRESHOLD_FOR_RECOVERY * 100).toFixed(2)}% достигнут для ${symbol}. Отслеживаем возврат к точке входа.`);
    }

    if (position.lossThresholdReached && !position.profitTargetReached) {
        const isBackToEntry = (position.side === 'BUY' && currentPrice >= entryPrice) || (position.side === 'SELL' && currentPrice <= entryPrice);
        if (isBackToEntry) {
            log(`Цена вернулась к точке входа после убытка для ${symbol}. Закрываем позицию.`);
            closePosition(symbol);
            return;
        }
    }

    if (isLosing && Math.abs(positionChange) >= LOSS_THRESHOLD) {
        log(`Порог убытка достигнут для ${symbol}: ${(positionChange * 100).toFixed(2)}%. Закрываем позицию.`);
        closePosition(symbol);
        return;
    }

    if (!position.profitTargetReached && isProfitable && Math.abs(positionChange) >= PROFIT_TARGET) {
        position.profitTargetReached = true;
        position.peakPrice = currentPrice;
        log(`Цель по прибыли достигнута для ${symbol}: ${(positionChange * 100).toFixed(2)}%. Отслеживаем коррекцию.`);
    }

    if (position.profitTargetReached) {
        const absProfit = Math.abs(positionChange);
        let dynamicCorrection;

        if (absProfit < 0.10) {
            dynamicCorrection = 0.01;  // 1%
        } else {
            dynamicCorrection = 0.05;  // 5%
        }

        let profitCorrection;
        if (position.side === 'BUY') {
            profitCorrection = (position.peakPrice - currentPrice) / position.peakPrice;
        } else {
            profitCorrection = (currentPrice - position.peakPrice) / position.peakPrice;
        }

        if (profitCorrection >= dynamicCorrection) {
            log(`Коррекция цены после достижения цели прибыли для ${symbol}. Текущая прибыль: ${(positionChange * 100).toFixed(2)}%, Коррекция ${(profitCorrection * 100).toFixed(2)}% >= ${(dynamicCorrection * 100).toFixed(2)}%. Закрываем позицию.`);
            closePosition(symbol);
            return;
        }
    }
}


    function logPriceChange(symbol, percentChange) {
        const currentPercent = Math.floor(percentChange * 100); // Преобразуем в целое число процентов
        const lastPercent = lastLoggedPercentChange[symbol] || 0; // Последний зафиксированный процент

        if (currentPercent !== lastPercent) { // Логгируем только если процент изменился
            log(`Символ: ${symbol}, Изменение цены: ${currentPercent}%`);
            lastLoggedPercentChange[symbol] = currentPercent; // Обновляем последний зафиксированный процент
        }
    }

    async function handlePriceUpdate(data) {
        const symbol = data.s;
        const currentPrice = parseFloat(data.c);
        const currentTime = Date.now();
      
        if (!symbol || isNaN(currentPrice)) return;

        priceUpdates[symbol] = currentPrice;

        if (openPositions[symbol]) {
            handleOpenPosition(symbol, currentPrice);
            return;
        }

        if (!priceHistory[symbol]) {
            priceHistory[symbol] = { time: currentTime, price: currentPrice };
            return;
        }
       

        const oldPriceEntry = priceHistory[symbol];
        const percentChange = (currentPrice - oldPriceEntry.price) / oldPriceEntry.price;

        if (Math.abs(percentChange) >= 0.01) { // 1% изменение цены
            logPriceChange(symbol, percentChange);
        }
        

        if (Math.abs(percentChange) >= PERCENT_CHANGE) {
            const direction = percentChange > 0 ? 'BUY' : 'SELL';
            const thresholdPrice = direction === 'BUY'
                ? oldPriceEntry.price * (1 + PERCENT_CHANGE)
                : oldPriceEntry.price * (1 - PERCENT_CHANGE);

            potentialEntries[symbol] = {
                direction,
                thresholdPrice,
                startTime: currentTime
            };

            log(`Обнаружено изменение цены для ${symbol}: ${(percentChange * 100).toFixed(2)}%. Начинаем отслеживание удержания цены для возможного входа в позицию ${direction}.`);
            return;
        }
        
        if (currentTime - oldPriceEntry.time >= WAIT_TIME * 1000) {
            priceHistory[symbol] = { time: currentTime, price: currentPrice };
        }

        if (potentialEntries[symbol]) {
            const entry = potentialEntries[symbol];
            const elapsedTime = currentTime - entry.startTime;

            let allowedMinPrice, allowedMaxPrice;
            if (entry.direction === 'BUY') {
                allowedMinPrice = entry.thresholdPrice * (1 - MAX_CORRECTION);
                
            } else {
                allowedMaxPrice = entry.thresholdPrice * (1 + MAX_CORRECTION);
            
            }

            let conditionsMet = true;
            if (entry.direction === 'BUY') {
                if (currentPrice < allowedMinPrice) {
                    conditionsMet = false;
                }
            } else {
                if (currentPrice > allowedMaxPrice) {
                    conditionsMet = false;
                }
            }

            if (!conditionsMet) {
                log(`Цена по ${symbol} не удержалась в рамках MAX_CORRECTION. Сбрасываем отслеживание.`);
                delete potentialEntries[symbol];
                return;
            }

           
            if (elapsedTime >= WAIT_TIME * 1000) {
                if ((entry.direction === 'BUY' && currentPrice >= entry.thresholdPrice) ||
                    (entry.direction === 'SELL' && currentPrice <= entry.thresholdPrice)) {
                if (!inProgress[symbol]) {
                        inProgress[symbol] = true;
                        delete potentialEntries[symbol]; // Удаляем сразу, чтобы повторно не попробовать открыть позицию
                         await openPosition(symbol, entry.direction)
                        .finally(() => {
                            inProgress[symbol] = false; // После завершения попытки открытия позиции, снимаем флаг
                        });
                        } else {
                            log(`Для ${symbol} уже идёт попытка открытия позиции. Пропускаем.`);
                        }
                } else {
                log(`По истечении ${WAIT_TIME/1000}с условия для входа по ${symbol} не выполнены. Сбрасываем.`);
                delete potentialEntries[symbol];
                }
                
            }
        }
    }

async function startTrading() {
    log('Запуск торговой системы');
    await getAccountBalance();
    const symbols = await getSymbolList();
    const streams = symbols.map(symbol => `${symbol.toLowerCase()}@ticker`);
    const maxStreamsPerConnection = 200;
    const connections = [];

    for (let i = 0; i < streams.length; i += maxStreamsPerConnection) {
        const streamSlice = streams.slice(i, i + maxStreamsPerConnection);
        const wsUrl = `${WS_BASE_URL}?streams=${streamSlice.join('/')}`;
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            log('WebSocket подключение установлено');
        });

        ws.on('message', (data) => {
            const parsedData = JSON.parse(data);
            if (parsedData.stream && parsedData.data) {
                handlePriceUpdate(parsedData.data);
            }
        });

        ws.on('error', (error) => {
            log(`WebSocket ошибка: ${error.message}`);
        });

        ws.on('close', () => {
            log('WebSocket подключение закрыто. Переподключаемся...');
            setTimeout(startTrading, 5000);
        });

        connections.push(ws);
    }
}

startTrading();