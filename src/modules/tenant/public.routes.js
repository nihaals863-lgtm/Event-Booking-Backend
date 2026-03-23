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
                },
                ticketrelease: {
                    where: { isActive: true },
                    orderBy: [
                        { releaseDate: 'asc' },
                        { price: 'asc' }
                    ]
                }
            },
            orderBy: {
                eventDate: 'asc'
            }
        });

        const now = new Date();
        const mappedEvents = events
            .filter(e => {
                if (e.pricingType === 'MULTI') {
                    // Only show events that have at least one potentially active tier
                    return e.ticketrelease.some(tr => tr.isActive && (tr.sold < tr.quantity));
                }
                return true;
            })
            .map(e => {
                const releasesWithStatus = (e.ticketrelease || []).map(tr => {
                    let status = 'INACTIVE';
                    if (tr.isActive) {
                        if (tr.sold >= tr.quantity) status = 'SOLD_OUT';
                        else if (tr.releaseDate && now < new Date(tr.releaseDate)) status = 'COMING_SOON';
                        else if (tr.endDate && now > new Date(tr.endDate)) status = 'EXPIRED';
                        else status = 'ACTIVE';
                    }
                    return { ...tr, status };
                });

                const activeReleases = releasesWithStatus.filter(r => r.status === 'ACTIVE');
                let minPrice = e.ticketPrice;
                let maxPrice = e.ticketPrice;
                let minPriceCents = e.ticketPriceCents;
                let maxPriceCents = e.ticketPriceCents;

                if (e.pricingType === 'MULTI' && activeReleases.length > 0) {
                    const prices = activeReleases.map(r => r.price);
                    const pricesCents = activeReleases.map(r => r.priceCents);
                    minPrice = Math.min(...prices);
                    maxPrice = Math.max(...prices);
                    minPriceCents = Math.min(...pricesCents);
                    maxPriceCents = Math.max(...pricesCents);
                } else if (e.pricingType === 'MULTI' && releasesWithStatus.length > 0) {
                    // Fallback to all active (but maybe sold out/expired) for price range
                    const allActive = releasesWithStatus.filter(r => r.isActive);
                    if (allActive.length > 0) {
                        minPrice = Math.min(...allActive.map(r => r.price));
                        maxPrice = Math.max(...allActive.map(r => r.price));
                        minPriceCents = Math.min(...allActive.map(r => r.priceCents));
                        maxPriceCents = Math.max(...allActive.map(r => r.priceCents));
                    }
                }

                // For MULTI events: compute accurate sold/total from actual release data
                let accurateTicketsSold = e.ticketsSold || 0;
                let accurateTotalTickets = e.totalTickets || 0;
                if (e.pricingType === 'MULTI' && releasesWithStatus.length > 0) {
                    accurateTicketsSold = releasesWithStatus.reduce((sum, r) => sum + (r.sold || 0), 0);
                    accurateTotalTickets = releasesWithStatus.reduce((sum, r) => sum + (r.quantity || 0), 0);
                }

                return {
                    ...e,
                    ticketsSold: accurateTicketsSold,
                    totalTickets: accurateTotalTickets,
                    ticketrelease: releasesWithStatus,
                    organizer: e.user_event_organizerIdTouser,
                    minPrice,
                    maxPrice,
                    minPriceCents,
                    maxPriceCents
                };
            });

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
                },
                ticketrelease: {
                    orderBy: [
                        { releaseDate: 'asc' },
                        { price: 'asc' }
                    ]
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

        const now = new Date();
        const releasesWithStatus = (event.ticketrelease || []).map(tr => {
            let status = 'INACTIVE';
            if (tr.isActive) {
                if (tr.sold >= tr.quantity) status = 'SOLD_OUT';
                else if (tr.releaseDate && now < new Date(tr.releaseDate)) status = 'COMING_SOON';
                else if (tr.endDate && now > new Date(tr.endDate)) status = 'EXPIRED';
                else status = 'ACTIVE';
            }
            return { ...tr, status };
        });

        const eventData = {
            ...event,
            ticketReleases: releasesWithStatus,
            tags: event.tags ? (typeof event.tags === 'string' ? JSON.parse(event.tags) : event.tags) : [],
            highlights: event.highlights ? (typeof event.highlights === 'string' ? JSON.parse(event.highlights) : event.highlights) : [],
            organizer: event.user_event_organizerIdTouser,
            galleryImages: event.eventimage,
            schedule: event.eventschedule
        };

        // Calculate price range for details based on current availability
        if (event.pricingType === 'MULTI') {
            const activeReleases = releasesWithStatus.filter(r => r.status === 'ACTIVE');
            if (activeReleases.length > 0) {
                const prices = activeReleases.map(r => r.price);
                eventData.minPrice = Math.min(...prices);
                eventData.maxPrice = Math.max(...prices);
            } else {
                const allActive = releasesWithStatus.filter(r => r.isActive);
                if (allActive.length > 0) {
                    const prices = allActive.map(r => r.price);
                    eventData.minPrice = Math.min(...prices);
                    eventData.maxPrice = Math.max(...prices);
                }
            }

            // Accurate sold/total from release sums (more reliable than event-level counter)
            if (releasesWithStatus.length > 0) {
                eventData.ticketsSold = releasesWithStatus.reduce((sum, r) => sum + (r.sold || 0), 0);
                eventData.totalTickets = releasesWithStatus.reduce((sum, r) => sum + (r.quantity || 0), 0);
            }
        }

        res.json(eventData);
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
                ticketrelease: true,
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
 * @route GET /api/public/orders/:orderId/tickets
 * @desc  Fetch all tickets associated with a Purchase Order
 */
router.get('/orders/:orderId/tickets', async (req, res) => {
    try {
        const { orderId } = req.params;

        let tickets = await prisma.ticket.findMany({
            where: { purchaseOrderId: orderId },
            include: {
                ticketrelease: true,
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
            },
            orderBy: { id: 'asc' }
        });

        // SELF-HEALING LOGIC: If no tickets found, check if order is stuck in PAYMENT_PENDING
        if (!tickets || tickets.length === 0) {
            const order = await prisma.purchaseorder.findUnique({
                where: { id: orderId }
            });

            if (order && order.paymentStatus === 'PAYMENT_PENDING' && order.stripeSessionId) {
                console.log(`[SELF_HEAL] Checking Stripe status for order: ${orderId}`);
                const { confirmOrderPayment } = require('../payments/stripe.webhook');
                const stripeService = require('../payments/stripe.service');

                try {
                    const session = await stripeService.getSession(order.stripeSessionId);
                    if (session.payment_status === 'paid') {
                        console.log(`[SELF_HEAL] Stripe confirmed 'paid'. Triggering manual recovery for ${orderId}`);
                        const generatedTickets = await confirmOrderPayment(session);
                        if (generatedTickets && generatedTickets.length > 0) {
                            // Re-fetch with full includes for consistent UI data
                            tickets = await prisma.ticket.findMany({
                                where: { purchaseOrderId: orderId },
                                include: {
                                    ticketrelease: true,
                                    event: { include: { user_event_organizerIdTouser: true } }
                                },
                                orderBy: { id: 'asc' }
                            });
                        }
                    } else {
                        console.log(`[SELF_HEAL] Stripe status is ${session.payment_status} for ${orderId}. Skipping recovery.`);
                    }
                } catch (stripeError) {
                    console.error(`[SELF_HEAL_ERROR] Stripe verification failed for ${orderId}:`, stripeError.message);
                }
            }
        }

        if (!tickets || tickets.length === 0) {
            return res.status(404).json({ error: 'No tickets found for this order. Payment may still be processing or was not completed.' });
        }

        res.json(tickets);
    } catch (error) {
        console.error('Error fetching order tickets:', error);
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

/**
 * @route GET /api/public/settings
 * @desc  Get platform settings (currency) - public, no auth required
 */
router.get('/settings', async (req, res) => {
    try {
        let settings = await prisma.platformsettings.findFirst();
        if (!settings) {
            settings = await prisma.platformsettings.create({ data: { currency: 'AUD' } });
        }
        res.json(settings);
    } catch (error) {
        console.error('Get public settings error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
