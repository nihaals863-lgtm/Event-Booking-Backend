const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../../config/db');

const router = express.Router();

/**
 * @route POST /api/auth/login
 * @desc  Login user and return JWT
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email }
        });

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Self-healing: Ensure demo accounts always have the correct roles
        if (email === 'admin@eventplatform.com' && user.role !== 'ADMIN') {
            await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
            user.role = 'ADMIN';
        } else if (email === 'organizer@eventplatform.com') {
            const updates = {};
            if (user.role !== 'ORGANIZER') updates.role = 'ORGANIZER';
            if (user.organizerStatus !== 'APPROVED') updates.organizerStatus = 'APPROVED';
            
            if (Object.keys(updates).length > 0) {
                await prisma.user.update({ where: { email }, data: updates });
                Object.assign(user, updates);
            }
        }

        if (user.status === 'SUSPENDED') {
            return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
        }

        // Organizer Approval Gate: Block pending/rejected organizers from logging in
        if (user.role === 'ORGANIZER' && user.organizerStatus !== 'APPROVED') {
            if (user.organizerStatus === 'REJECTED') {
                return res.status(403).json({ 
                    error: 'Your organizer account application has been rejected. Please contact support.' 
                });
            }
            return res.status(403).json({ 
                error: 'Your organizer account is awaiting admin approval. Please wait until admin approves your request.' 
            });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role, email: user.email, status: user.status, organizerStatus: user.organizerStatus },
            process.env.JWT_SECRET || 'supersafe_jwt_secret_for_local_development',
            { expiresIn: '1d' }
        );

        res.json({
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                status: user.status,
                organizerStatus: user.organizerStatus
            },
            token
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route POST /api/auth/register
 * @desc  Register a new organizer
 */
router.post('/register', async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const existingUser = await prisma.user.findUnique({
            where: { email }
        });

        if (existingUser) {
            return res.status(400).json({ error: 'Email already in use' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        console.log('Attempting to create user with data:', { name, email, role: 'ORGANIZER' });
        
        const user = await prisma.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                role: 'ORGANIZER', 
                organizerStatus: 'PENDING'
            }
        });

        console.log('User created successfully:', user.id);

        res.status(202).json({
            pending: true,
            message: 'Your organizer account is pending admin approval. You will be able to login after approval.'
        });
    } catch (error) {
        console.error('Registration error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code,
            meta: error.meta
        });
        res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});

/**
 * Middleware to verify JWT
 */
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersafe_jwt_secret_for_local_development');
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

/**
 * @route PUT /api/auth/profile
 * @desc  Update user profile (name, email)
 */
router.put('/profile', authenticate, async (req, res) => {
    const { name, email } = req.body;
    const userId = req.user.id;

    try {
        // Check if email is already taken by another user
        if (email) {
            const existing = await prisma.user.findUnique({ where: { email } });
            if (existing && existing.id !== userId) {
                return res.status(400).json({ error: 'Email already in use' });
            }
        }

        const updated = await prisma.user.update({
            where: { id: userId },
            data: { name, email },
            select: { id: true, name: true, email: true, role: true, status: true }
        });

        res.json({ user: updated });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route PUT /api/auth/update-password
 * @desc  Update user password
 */
router.put('/update-password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const isValid = await bcrypt.compare(currentPassword, user.password);
        if (!isValid) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id: userId },
            data: { password: hashedPassword }
        });

        res.json({ message: 'Password updated successfully' });
    } catch (error) {
        console.error('Password update error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
