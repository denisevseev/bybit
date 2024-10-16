import time
import hmac
import hashlib
import requests
import logging
import math

# Binance API Key и секретный ключ
API_KEY = 'PDMeOejlai84O41KZ5Y8cTIiF51Gimx9YgNUFzmHavPOEJbR4UYVrPP2YOE6EADH'
SECRET_KEY = 'YvSqzPfvPDFMiyrNWgb0rwGEFCZ3q4brrFcyQIkehuGf0R3brlVvNzHjNBC88z1a'
BASE_URL = 'https://api.binance.com'

# Конфигурация торгового бота
TRADE_AMOUNT_PERCENT = 0.1
CHANGE_THRESHOLD = 7
PROFIT_THRESHOLD = 5
MIN_PROFIT_OR_LOSS_AMOUNT = 1
STOP_LOSS_THRESHOLD = 5
MONITORING_PERIOD = 24 * 60 * 60  # 24 часа в секундах
MIN_VOLUME_USDT = 100000
MIN_TRAILING_STOP_PROFIT = 1

pairs = {}

logging.basicConfig(filename='trades_log.log', level=logging.INFO)

def log_to_file(message):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    logging.info(f'{timestamp} - {message}')

def sign_query(query):
    return hmac.new(SECRET_KEY.encode(), query.encode(), hashlib.sha256).hexdigest()


def get_symbol_info(symbol):
    endpoint = '/api/v3/exchangeInfo'
    url = f'{BASE_URL}{endpoint}'
    response = requests.get(url)
    data = response.json()

    symbol_info = next((s for s in data['symbols'] if s['symbol'] == symbol), None)
    if not symbol_info:
        log_to_file(f'Информация о паре {symbol} не найдена')
        return None
    return symbol_info

def calculate_min_quantity(symbol, current_price):
    try:
        symbol_info = get_symbol_info(symbol)
        lot_size_filter = next(f for f in symbol_info['filters'] if f['filterType'] == 'LOT_SIZE')
        step_size = float(lot_size_filter['stepSize'])
        min_qty = float(lot_size_filter['minQty'])

        # Округляем количество по шагу лота
        trade_quantity = math.floor(min_qty / step_size) * step_size

        min_notional_filter = next((f for f in symbol_info['filters'] if f['filterType'] == 'MIN_NOTIONAL'), None)
        if min_notional_filter:
            min_notional = float(min_notional_filter['minNotional'])
            if trade_quantity * current_price < min_notional:
                trade_quantity = min_notional / current_price
                trade_quantity = math.floor(trade_quantity / step_size) * step_size

        log_to_file(f'Рассчитанное минимальное количество для {symbol}: {trade_quantity}')
        return trade_quantity
    except Exception as e:
        log_to_file(f'Ошибка при расчете минимального количества для {symbol}: {str(e)}')
        return None

def get_balance():
    endpoint = '/api/v3/account'
    timestamp = int(time.time() * 1000)
    query = f'timestamp={timestamp}'
    signature = sign_query(query)
    url = f'{BASE_URL}{endpoint}?{query}&signature={signature}'
    headers = {'X-MBX-APIKEY': API_KEY}

    try:
        response = requests.get(url, headers=headers)
        data = response.json()
        usdt_balance = next(b for b in data['balances'] if b['asset'] == 'USDT')
        current_balance = float(usdt_balance['free'])
        log_to_file(f'Баланс USDT: {current_balance} USDT')
        return current_balance
    except Exception as e:
        log_to_file(f'Ошибка при получении баланса: {str(e)}')
        return 0

def create_order(symbol, side, quantity):
    endpoint = '/api/v3/order'
    timestamp = int(time.time() * 1000)
    query = f'symbol={symbol}&side={side}&type=MARKET&quantity={quantity}&timestamp={timestamp}'
    signature = sign_query(query)
    url = f'{BASE_URL}{endpoint}?{query}&signature={signature}'
    headers = {'X-MBX-APIKEY': API_KEY}

    log_to_file(f'Попытка создать ордер: {symbol}, {side}, {quantity}')
    
    try:
        response = requests.post(url, headers=headers)
        response.raise_for_status()
        log_to_file(f'Успешно создан ордер: {side} {symbol}, количество: {quantity}')
        return response.json()
    except requests.exceptions.HTTPError as err:
        log_to_file(f'Ошибка при создании ордера: {err.response.json()["msg"]}')
        return None

def sell_asset(symbol):
    asset = symbol.replace('USDT', '')
    asset_balance = get_asset_balance(asset)

    if asset_balance > 0 and pairs[symbol]['inPosition']:
        create_order(symbol, 'SELL', asset_balance)
        log_to_file(f'Успешно продан актив {symbol}, количество: {asset_balance}')
        return asset_balance
    else:
        log_to_file(f'Недостаточно актива {symbol} для продажи')
        return None

def reset_pair_data(symbol, current_price):
    pairs[symbol] = {
        'initialPrice': current_price,
        'initialTime': time.time(),
        'inPosition': False,
        'entryPrice': None,
        'direction': None,
        'trailingStopActive': False,
        'highestPrice': None,
        'disableMonitoring': False
    }
    log_to_file(f'Сброс данных для пары {symbol}')

def process_ticker(ticker):
    symbol = ticker['s']
    current_price = float(ticker['c'])
    volume_24h = float(ticker['q'])

    if not symbol.endswith('USDT') or volume_24h < MIN_VOLUME_USDT:
        return

    now = time.time()

    if symbol not in pairs:
        pairs[symbol] = {
            'initialPrice': current_price,
            'initialTime': now,
            'inPosition': False,
            'entryPrice': None,
            'direction': None,
            'trailingStopActive': False,
            'highestPrice': None,
            'disableMonitoring': False
        }
        return

    pair_data = pairs[symbol]

    # Проверяем, прошло ли 24 часа для сброса данных
    if now - pair_data['initialTime'] >= MONITORING_PERIOD and not pair_data['inPosition'] and not pair_data['disableMonitoring']:
        reset_pair_data(symbol, current_price)
        log_to_file(f'Сброс данных для пары {symbol} после 24 часов')

    # Логика для открытия сделки
    if not pair_data['inPosition']:
        price_change_percent = ((current_price - pair_data['initialPrice']) / pair_data['initialPrice']) * 100

        if abs(price_change_percent) >= CHANGE_THRESHOLD:
            quantity = calculate_min_quantity(symbol, current_price)
            if quantity:
                create_order(symbol, 'BUY' if price_change_percent > 0 else 'SELL', quantity)
                pair_data['inPosition'] = True
                pair_data['entryPrice'] = current_price
                pair_data['direction'] = 'up' if price_change_percent > 0 else 'down'
                pair_data['highestPrice'] = current_price
                pair_data['disableMonitoring'] = True

# Запуск WebSocket соединения
def start_websocket():
    ws = WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr')

    def on_message(ws, message):
        tickers = json.loads(message)
        for ticker in tickers:
            process_ticker(ticker)

    ws.on_open = lambda ws: log_to_file('WebSocket подключен')
    ws.on_message = on_message
    ws.run_forever()

if __name__ == "__main__":
    get_balance()
    start_websocket()
