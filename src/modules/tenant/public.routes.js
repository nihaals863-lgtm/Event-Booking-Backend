const express = require('express');
const prisma = require('../../config/db');

const router = express.Router();

/**
 * @route GET /api/public/events
 * @desc  Get all approved events for public listing
 */
router.get('/events', async (req, res) => {
    try {
        const events = await prisma.event.findMany({
            where: {
                status: 'APPROVED',
                isPublic: true
            },
            include: {
                user_event_organizerIdTouser: {
                    select: {
                        name: true
                    }
                }
            },
            orderBy: {
                eventDate: 'asc'
            }
        });

        // Map response for frontend
        const mappedEvents = events.map(e => ({
            ...e,
            organizer: e.user_event_organizerIdTouser
        }));

        res.json(mappedEvents);
    } catch (error) {
        console.error('Error fetching public events:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/public/events/:id
 * @desc  Get event details by ID
 */
router.get('/events/:id', async (req, res) => {
    const { id } = req.params;
    const eventId = parseInt(id);
    if (isNaN(eventId)) {
        return res.status(400).json({ error: 'Invalid event ID' });
    }
    try {
        const event = await prisma.event.findUnique({
            where: { id: eventId },
            include: {
                user_event_organizerIdTouser: {
                    select: {
                        name: true
                    }
                },
                eventimage: {
                    orderBy: {
                        displayOrder: 'asc'
                    }
                },
                eventschedule: {
                    orderBy: {
                        orderIndex: 'asc'
                    }
                }
            }
        });

        if (!event) return res.status(404).json({ error: 'Event not found' });

        // Visibility Check:
        // 1. If not approved, only allow if preview=true
        // 2. If private, only allow if private=true OR preview=true
        const isApproved = event.status === 'APPROVED';
        const isPublic = event.isPublic;
        const isPreview = req.query.preview === 'true';
        const isPrivateAccess = req.query.private === 'true';

        if (!isApproved && !isPreview) {
            return res.status(403).json({ error: 'This event is currently awaiting admin approval.' });
        }

        if (!isPublic && !isPrivateAccess && !isPreview) {
            return res.status(404).json({ error: 'This is a private event. You need a direct link to access it.' });
        }

        res.json({
            ...event,
            tags: event.tags ? (typeof event.tags === 'string' ? JSON.parse(event.tags) : event.tags) : [],
            highlights: event.highlights ? (typeof event.highlights === 'string' ? JSON.parse(event.highlights) : event.highlights) : [],
            organizer: event.user_event_organizerIdTouser,
            galleryImages: event.eventimage,
            schedule: event.eventschedule
        });
    } catch (error) {
        console.error('Error fetching event details:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/public/tickets/:id
 * @desc  Fetch ticket by ID (Public)
 */
router.get('/tickets/:id', async (req, res) => {
    try {
        const ticketId = parseInt(req.params.id);
        if (isNaN(ticketId)) {
            return res.status(400).json({ error: 'Invalid ticket ID format' });
        }

        const ticket = await prisma.ticket.findUnique({
            where: { id: ticketId },
            include: {
                event: {
                    select: {
                        title: true,
                        location: true,
                        eventDate: true,
                        image: true,
                        isPublic: true,
                        user_event_organizerIdTouser: {
                            select: {
                                name: true,
                                email: true
                            }
                        }
                    }
                }
            }
        });

        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        res.json(ticket);
    } catch (error) {
        console.error('Error fetching ticket:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/public/promo/:eventId/:code
 * @desc  Validate a promo code
 */
router.get('/promo/:eventId/:code', async (req, res) => {
    const { eventId, code } = req.params;
    try {
        const promo = await prisma.promocode.findUnique({
            where: {
                eventId_code: {
                    eventId: parseInt(eventId),
                    code: code.toUpperCase()
                }
            }
        });

        if (!promo) {
            return res.status(404).json({ error: 'Invalid promo code' });
        }

        // Check expiry and usage
        if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
            return res.status(400).json({ error: 'Promo code expired' });
        }

        if (promo.maxUsage > 0 && promo.currentUsage >= promo.maxUsage) {
            return res.status(400).json({ error: 'Promo code use limit reached' });
        }

        res.json({
            code: promo.code,
            discountType: promo.discountType.toLowerCase(),
            value: promo.discountValue
        });
    } catch (error) {
        console.error('Promo validation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/public/stats
 * @desc  Get platform-wide statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const totalEvents = await prisma.event.count({
            where: { status: 'APPROVED' }
        });

        const events = await prisma.event.findMany({
            select: { ticketsSold: true }
        });
        const totalTicketsSold = events.reduce((acc, e) => acc + (e.ticketsSold || 0), 0);

        res.json({
            totalEvents,
            totalTicketsSold
        });
    } catch (error) {
        console.error('Error fetching public stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
