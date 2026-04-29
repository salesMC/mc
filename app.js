// app.js
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Увеличили лимит размера тела запроса (важно для загрузки фото в base64)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));   // ← Это было критично

// ==================== СОЗДАНИЕ ПАПКИ ДЛЯ ДАННЫХ ====================
const dataDir = path.join(__dirname, 'data');
const ordersFile = path.join(dataDir, 'orders.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

if (!fs.existsSync(ordersFile)) {
  fs.writeFileSync(ordersFile, JSON.stringify([], null, 2));
}

// ==================== МАРШРУТЫ ====================

// Главная и основные страницы
app.get('/', (req, res) => res.render('index'));
app.get('/calculator', (req, res) => res.render('calculator'));
app.get('/payment', (req, res) => res.render('payment'));
app.get('/quote-success', (req, res) => res.render('quote-success'));

// Shippers
app.get('/auctions', (req, res) => res.render('auctions'));
app.get('/dealers', (req, res) => res.render('dealers'));
app.get('/oems', (req, res) => res.render('oems'));
app.get('/fleet', (req, res) => res.render('fleet'));
app.get('/individuals', (req, res) => res.render('individuals'));
app.get('/contact', (req, res) => res.render('contact'));
app.get('/decision', (req, res) => res.render('decision'));

// Carriers
app.get('/haul-with-mc', (req, res) => res.render('haul'));
app.get('/payment-tracker', (req, res) => res.render('payment-tracker'));

// Company
app.get('/team', (req, res) => res.render('team'));
app.get('/careers', (req, res) => res.render('careers'));
app.get('/blog', (req, res) => res.render('blog'));
app.get('/extension', (req, res) => res.render('extension'));

// Admin
app.get('/admin', (req, res) => res.render('admin'));
app.get('/sign-in', (req, res) => res.render('sign-in'));

// ==================== API ====================

// Получить все заказы
app.get('/api/orders', (req, res) => {
  try {
    const orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.json([]);
  }
});

// Создать новый заказ
app.post('/api/orders', (req, res) => {
  try {
    let orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
    
    const newOrder = {
      ...req.body,
      createdAt: new Date().toISOString()
    };

    orders.unshift(newOrder); // новый заказ в начало списка
    fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
    
    console.log(`Новый заказ создан: ${newOrder.id}`);
    res.json({ success: true, orderId: newOrder.id });
  } catch (error) {
    console.error('Ошибка при сохранении заказа:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Обновить статус заказа
app.patch('/api/orders/:id/status', (req, res) => {
  try {
    let orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
    const order = orders.find(o => o.id === req.params.id);
    
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    order.status = req.body.status;
    fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// Удалить заказ
app.delete('/api/orders/:id', (req, res) => {
  try {
    let orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
    const initialLength = orders.length;
    
    orders = orders.filter(o => o.id !== req.params.id);
    
    if (orders.length === initialLength) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// ==================== 404 ====================
app.use((req, res) => {
  res.status(404).render('404');
});

// ==================== ЗАПУСК СЕРВЕРА ====================
app.listen(PORT, () => {
  console.log(`\n🚀 MC Transportation запущен на http://localhost:${PORT}`);
  console.log(`   Админ-панель: http://localhost:${PORT}/admin`);
  console.log(`   Калькулятор:  http://localhost:${PORT}/calculator\n`);
});