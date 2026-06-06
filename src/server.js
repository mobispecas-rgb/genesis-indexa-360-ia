require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const app = express();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Conexão MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/genesis-ntc')
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB erro:', err));

// Rotas
app.use('/api/produtos',    require('./routes/produtos'));
app.use('/api/ntc',         require('./routes/ntc'));
app.use('/api/aplicacoes',  require('./routes/aplicacoes'));
app.use('/api/oem',         require('./routes/oem'));
app.use('/api/fiscal',      require('./routes/fiscal'));
app.use('/api/logistica',   require('./routes/logistica'));
app.use('/api/imagens',     require('./routes/imagens'));
app.use('/api/midway',      require('./routes/midway'));
app.use('/api/marketplace', require('./routes/marketplace'));

// Frontend — serve index.html para todas as rotas não-API
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('ERRO:', err.message);
  res.status(err.status || 500).json({ erro: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Genesis NTC rodando na porta ${PORT}`));
