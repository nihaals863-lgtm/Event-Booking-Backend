const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middlewares
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        
        const isAllowed = origin.includes('localhost') || 
                          origin.includes('127.0.0.1') || 
                          origin.includes('ngrok') || 
                          origin.includes('netlify.app');
        
        if (isAllowed) {
            callback(null, true);
        } else {
            console.warn(`[CORS] Rejected origin: ${origin}`);
            callback(null, false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));
app.use(express.json());

// Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Routes
const authRoutes = require('./modules/auth/auth.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const organizerRoutes = require('./modules/owner/organizer.routes');
const tenantRoutes = require('./modules/tenant/tenant.routes');
const publicRoutes = require('./modules/tenant/public.routes');

app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'Backend is running' });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/organizer', organizerRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/tickets', tenantRoutes);

module.exports = app;
