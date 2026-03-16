const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../../config/db');
const { requireAuth, requireRole } = require('../../middlewares/authMiddleware');

const router = express.Router();

/**
 * @route GET /api/admin/events/moderation-stats
 * @desc  Get stats for moderation dashboard
 */
router.get('/events/moderation-stats', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const [pendingCount, suspendedUsers, totalReviewed, approvedCount] = await Promise.all([
            prisma.event.count({ where: { status: 'PENDING' } }),
            prisma.user.count({ where: { status: 'SUSPENDED' } }),
            prisma.event.count({
                where: {
                    status: { in: ['APPROVED', 'REJECTED'] }
                }
            }),
            prisma.event.count({ where: { status: 'APPROVED' } })
        ]);

        const approvalRate = totalReviewed > 0 
            ? Math.round((approvedCount / totalReviewed) * 100) 
            : 0;

        res.json({
            pendingCount,
            suspendedUsers,
            approvalRate,
            flaggedReports: 0 // Placeholder for future report system
        });
    } catch (error) {
        console.error('Moderation stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/admin/events
 * @desc  Get all events for moderation
 */
router.get('/events', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const events = await prisma.event.findMany({
            include: {
                user_event_organizerIdTouser: {
                    select: {
                        name: true,
                        email: true
                    }
                },
                user_event_reviewedByIdTouser: {
                    select: {
                        name: true
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        // Map responses for frontend
        const mappedEvents = events.map(e => ({
            ...e,
            organizer: e.user_event_organizerIdTouser,
            reviewedBy: e.user_event_reviewedByIdTouser
        }));

        res.json(mappedEvents);
    } catch (error) {
        console.error('Error fetching admin events:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/admin/events/history
 * @desc  Get history of reviewed events (Approved/Rejected)
 */
router.get('/events/history', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const history = await prisma.event.findMany({
            where: {
                status: { in: ['APPROVED', 'REJECTED'] }
            },
            include: {
                user_event_organizerIdTouser: {
                    select: { name: true }
                },
                user_event_reviewedByIdTouser: {
                    select: { name: true }
                }
            },
            orderBy: {
                updatedAt: 'desc'
            }
        });

        const mappedHistory = history.map(e => ({
            id: e.id,
            eventId: e.id, // for details lookup
            eventName: e.title,
            category: e.category,
            location: e.location,
            eventDate: e.eventDate,
            ticketPrice: e.ticketPrice,
            totalTickets: e.totalTickets,
            organizer: e.user_event_organizerIdTouser?.name || 'Unknown',
            decision: e.status === 'APPROVED' ? 'Approved' : 'Rejected',
            reviewedBy: e.user_event_reviewedByIdTouser?.name || 'Platform Admin',
            reason: e.rejectionReason,
            date: e.updatedAt || e.createdAt
        }));

        res.json(mappedHistory);
    } catch (error) {
        console.error('Error fetching review history:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/admin/events/:id
 * @desc  Get full detailed event for admin audit
 */
router.get('/events/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid event identifier provided' });
        }

        const eventDetail = await prisma.event.findUnique({
            where: { id: id },
            include: {
                user_event_organizerIdTouser: {
                    select: { name: true, email: true }
                },
                user_event_reviewedByIdTouser: {
                    select: { name: true }
                },
                eventimage: true,
                ticketrelease: true,
                promocode: true,
                eventschedule: {
                    orderBy: { orderIndex: 'asc' }
                }
            }
        });

        if (!eventDetail) {
            return res.status(404).json({ error: 'Event record not found' });
        }

        res.json(eventDetail);
    } catch (error) {
        console.error('Error fetching admin event detail:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * @route GET /api/admin/dashboard
 * @desc  Get system-wide stats and recent events for admin dashboard
 */
router.get('/dashboard', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const now = new Date();
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());

        const [
            totalEvents, 
            pendingEvents, 
            totalUsers, 
            totalTickets, 
            recentEvents,
            eventsLastMonth,
            usersLastMonth,
            totalOrganizers
        ] = await Promise.all([
            prisma.event.count(),
            prisma.event.count({ where: { status: 'PENDING' } }),
            prisma.user.count(),
            prisma.ticket.count(),
            prisma.event.findMany({
                take: 5,
                orderBy: { createdAt: 'desc' },
                include: {
                    user_event_organizerIdTouser: {
                        select: { name: true }
                    }
                }
            }),
            prisma.event.count({ where: { createdAt: { gte: lastMonth } } }),
            prisma.user.count({ where: { createdAt: { gte: lastMonth } } }),
            prisma.user.count({ where: { role: 'ORGANIZER' } })
        ]);

        const revStats = await prisma.event.findMany({
            select: {
                ticketsSold: true,
                ticketPrice: true,
                serviceFeeType: true,
                serviceFeeRate: true
            }
        });

        const totalRevenue = revStats.reduce((sum, ev) => sum + ((ev.ticketsSold || 0) * ev.ticketPrice), 0);
        const platformRevenue = revStats.reduce((sum, ev) => {
            const gross = (ev.ticketsSold || 0) * ev.ticketPrice;
            const fee = gross * (ev.serviceFeeRate || 0.03);
            return sum + fee;
        }, 0);
        const netRevenue = totalRevenue - platformRevenue;
        
        // Calculate Growth Percentages
        const eventGrowth = totalEvents > eventsLastMonth 
            ? Math.round(((totalEvents - (totalEvents - eventsLastMonth)) / (totalEvents - eventsLastMonth || 1)) * 100) 
            : 0;
            
        const userGrowth = totalUsers > usersLastMonth
            ? Math.round(((totalUsers - (totalUsers - usersLastMonth)) / (totalUsers - usersLastMonth || 1)) * 100)
            : 0;

        res.json({
            totalEvents,
            pendingEvents,
            totalUsers,
            totalTicketsSold: totalTickets,
            totalGrossRevenue: totalRevenue,
            totalPlatformRevenue: platformRevenue,
            totalNetRevenue: netRevenue,
            eventGrowth: `+${eventsLastMonth} this month`,
            userGrowth: `+${usersLastMonth} this month`,
            totalOrganizers,
            recentEvents: recentEvents.map(e => ({
                ...e,
                organizerName: e.user_event_organizerIdTouser?.name || 'Unknown'
            }))
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/admin/stats
 * @desc  Get system-wide stats for admin dashboard (Legacy/Compact)
 */
router.get('/stats', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const [totalEvents, pendingEvents, totalUsers, totalTickets] = await Promise.all([
            prisma.event.count(),
            prisma.event.count({ where: { status: 'PENDING' } }),
            prisma.user.count(),
            prisma.ticket.count()
        ]);

        const revStats = await prisma.event.findMany({
            select: {
                ticketsSold: true,
                ticketPrice: true,
                serviceFeeType: true,
                serviceFeeRate: true
            }
        });

        const totalRevenue = revStats.reduce((sum, ev) => sum + ((ev.ticketsSold || 0) * ev.ticketPrice), 0);
        const platformRevenue = revStats.reduce((sum, ev) => {
            const gross = (ev.ticketsSold || 0) * ev.ticketPrice;
            const fee = gross * (ev.serviceFeeRate || 0.03);
            return sum + fee;
        }, 0);

        res.json({
            totalEvents,
            pendingEvents,
            totalUsers,
            ticketsSold: totalTickets,
            revenue: totalRevenue,
            platformRevenue
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route PATCH /api/admin/events/:id/status
 * @desc  Update event status
 */
router.patch('/events/:id/status', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;

    try {
        const updatedEvent = await prisma.event.update({
            where: { id: parseInt(id) },
            data: {
                status,
                reviewedById: req.user.id,
                rejectionReason: status === 'REJECTED' ? reason : null
            }
        });
        res.json(updatedEvent);
    } catch (error) {
        console.error('Error updating event status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/admin/users
 * @desc  Get all users
 */
router.get('/users', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                isVerified: true,
                createdAt: true
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route PATCH /api/admin/users/:id/role
 * @desc  Change user role
 */
router.patch('/users/:id/role', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ['ADMIN', 'ORGANIZER', 'TENANT', 'STAFF'];
    if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }

    try {
        const user = await prisma.user.update({
            where: { id: parseInt(id) },
            data: { role }
        });
        res.json(user);
    } catch (error) {
        console.error('Update role error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route PATCH /api/admin/users/:id/status
 * @desc  Update user status (SUSPENDED/ACTIVE)
 */
router.patch('/users/:id/status', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const validStatus = ['ACTIVE', 'SUSPENDED'];
    if (!validStatus.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    // Safety: Prevent self-suspension
    if (parseInt(id) === req.user.id && status === 'SUSPENDED') {
        return res.status(403).json({ error: 'Safety Guard: You cannot suspend your own account.' });
    }

    try {
        const user = await prisma.user.update({
            where: { id: parseInt(id) },
            data: { status }
        });
        res.json(user);
    } catch (error) {
        console.error('Update status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route PATCH /api/admin/users/:id/verify
 * @desc  Toggle user verification status
 */
router.patch('/users/:id/verify', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    const { id } = req.params;
    const { isVerified } = req.body;

    try {
        const user = await prisma.user.update({
            where: { id: parseInt(id) },
            data: { isVerified: !!isVerified }
        });
        res.json(user);
    } catch (error) {
        console.error('Update verification error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/admin/organizer-requests
 * @desc  Get all organizers for approval
 */
router.get('/organizer-requests', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    const { status } = req.query; // optional filter: PENDING | APPROVED | REJECTED

    try {
        const where = { role: 'ORGANIZER' };
        if (status) {
            where.organizerStatus = status;
        }

        const organizers = await prisma.user.findMany({
            where,
            select: {
                id: true,
                name: true,
                email: true,
                organizerStatus: true,
                status: true,
                createdAt: true
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(organizers);
    } catch (error) {
        console.error('Error fetching organizer requests:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route PATCH /api/admin/organizers/:id/approve
 * @desc  Approve organizer account
 */
router.patch('/organizers/:id/approve', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    const { id } = req.params;

    try {
        const user = await prisma.user.update({
            where: { id: parseInt(id) },
            data: { organizerStatus: 'APPROVED' }
        });
        res.json({ message: 'Organizer approved successfully', user });
    } catch (error) {
        console.error('Approve organizer error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route PATCH /api/admin/organizers/:id/reject
 * @desc  Reject organizer account
 */
router.patch('/organizers/:id/reject', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    const { id } = req.params;

    try {
        const user = await prisma.user.update({
            where: { id: parseInt(id) },
            data: { organizerStatus: 'REJECTED' }
        });
        res.json({ message: 'Organizer rejected successfully', user });
    } catch (error) {
        console.error('Reject organizer error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
