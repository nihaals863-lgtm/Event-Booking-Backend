const express = require('express');
const prisma = require('../../config/db');
const { requireAuth, requireRole } = require('../../middlewares/authMiddleware');

const router = express.Router();

/**
 * @route POST /api/organizer/events
 * @desc  Create a new event
 */
router.post('/events', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const {
        title, category, description, location, eventDate, ticketPrice,
        totalTickets, image, tags, highlights, promoCodes,
        isPublic, sellingFastThreshold, galleryImages, ticketReleases,
        serviceFeeType, serviceFeeRate, pricingType
    } = req.body;

    console.log('--- EVENT CREATION REQUEST ---');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    try {
        const parsedPrice = parseFloat(ticketPrice);
        const parsedCapacity = parseInt(totalTickets);

        if (isNaN(parsedPrice) || isNaN(parsedCapacity)) {
            console.error('Validation Error: Price or Capacity is NaN', { parsedPrice, parsedCapacity });
            return res.status(400).json({ error: 'Invalid price or capacity format' });
        }

        const prismaData = {
            title,
            category: category || 'General',
            description: description || '',
            location,
            eventDate: new Date(eventDate),
            ticketPrice: parsedPrice,
            ticketPriceCents: Math.round(parsedPrice * 100),
            totalTickets: parsedCapacity,
            image: image || null,
            organizerId: req.user.id,
            status: 'PENDING',
            pricingType: pricingType || 'SINGLE',
            isPublic: isPublic !== undefined ? isPublic : true,
            sellingFastThreshold: sellingFastThreshold ? parseInt(sellingFastThreshold) : 20,
            serviceFeeType: serviceFeeType || 'BUYER',
            serviceFeeRate: serviceFeeRate ? parseFloat(serviceFeeRate) : 0.03,
            tags: tags ? JSON.stringify(tags) : null,
            highlights: highlights ? JSON.stringify(highlights) : null,
            promocode: (promoCodes && promoCodes.length > 0) ? {
                create: promoCodes.map(pc => ({
                    code: pc.code.toUpperCase(),
                    discountType: (pc.discountType || pc.type || 'PERCENTAGE').toUpperCase(),
                    discountValue: parseFloat(pc.discountValue || pc.value || 0),
                    maxUsage: pc.maxUsage || (pc.limit ? parseInt(pc.limit) : 0),
                    expiresAt: pc.expiresAt ? new Date(pc.expiresAt) : (pc.expiry ? new Date(pc.expiry) : null)
                }))
            } : undefined,
            eventimage: (galleryImages && galleryImages.length > 0) ? {
                create: galleryImages.map((imgUrl, index) => ({
                    imageUrl: imgUrl,
                    displayOrder: index
                }))
            } : undefined,
            ticketrelease: (pricingType === 'MULTI' && ticketReleases && ticketReleases.length > 0) ? {
                create: (() => {
                    let foundActive = false;
                    return ticketReleases.filter(tr => parseInt(tr.quantity) > 0).map(tr => {
                        const trIsActive = tr.isActive ?? false;
                        const finalActive = trIsActive && !foundActive;
                        if (finalActive) foundActive = true;

                        return {
                            name: tr.name,
                            price: parseFloat(tr.price) || 0,
                            priceCents: Math.round((parseFloat(tr.price) || 0) * 100),
                            quantity: parseInt(tr.quantity) || 0,
                            releaseDate: tr.releaseDate ? new Date(tr.releaseDate) : null,
                            endDate: tr.endDate ? new Date(tr.endDate) : null,
                            isActive: finalActive
                        };
                    });
                })()
            } : undefined,
            updatedAt: new Date()
        };

        console.log('Prisma Payload:', JSON.stringify(prismaData, null, 2));

        const newEvent = await prisma.event.create({
            data: prismaData
        });
        res.status(201).json(newEvent);
    } catch (error) {
        console.error('Error creating event:', error);
        // Log detailed error for debugging
        if (error.code) console.error('Prisma Error Code:', error.code);
        if (error.meta) console.error('Prisma Error Meta:', error.meta);

        if (error.name === 'PrismaClientKnownRequestError') {
            return res.status(400).json({ error: 'Database constraint violation. Please check your data.' });
        }
        res.status(500).json({ error: 'Failed to create event. Please verify all fields and try again.' });
    }
});

/**
 * @route GET /api/organizer/events
 * @desc  Get events created by the logged in organizer
 */
router.get('/events', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    try {
        const events = await prisma.event.findMany({
            where: {
                organizerId: req.user.id
            },
            orderBy: {
                createdAt: 'desc'
            }
        });
        res.json(events);
    } catch (error) {
        console.error('Error fetching organizer events:', error);
        res.status(500).json({ error: 'Unable to retrieve your events. Please refresh the page.' });
    }
});

/**
 * @route GET /api/organizer/events/:id
 * @desc  Get single event details for editing
 */
router.get('/events/:id', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const { id } = req.params;
    try {
        const event = await prisma.event.findUnique({
            where: { id: parseInt(id) },
            include: {
                eventimage: true,
                promocode: true,
                eventschedule: true,
                ticketrelease: true
            }
        });

        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Map response for frontend
        const mappedEvent = {
            ...event,
            tags: event.tags ? (typeof event.tags === 'string' ? JSON.parse(event.tags) : event.tags) : [],
            highlights: event.highlights ? (typeof event.highlights === 'string' ? JSON.parse(event.highlights) : event.highlights) : [],
            galleryImages: event.eventimage,
            promoCodes: event.promocode,
            schedule: event.eventschedule,
            ticketReleases: event.ticketrelease
        };

        res.json(mappedEvent);
    } catch (error) {
        console.error('Error fetching event details:', error);
        res.status(500).json({ error: 'Failed to load event details. Please try again.' });
    }
});

/**
 * @route PATCH /api/organizer/events/:id
 * @desc  Update an event's details
 */
router.patch('/events/:id', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const { id } = req.params;
    const {
        title, category, description, location, eventDate, ticketPrice,
        totalTickets, image, tags, highlights, promoCodes,
        isPublic, sellingFastThreshold, galleryImages, ticketReleases,
        serviceFeeType, serviceFeeRate, pricingType
    } = req.body;

    try {
        const event = await prisma.event.findUnique({
            where: { id: parseInt(id) }
        });

        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized to edit this event' });
        }

        // GUARD: Prevent switching pricingType if tickets have been sold
        if (pricingType && pricingType !== event.pricingType && event.ticketsSold > 0) {
            return res.status(400).json({ error: 'Cannot change pricing type after tickets have been sold.' });
        }

        // 1. Update basic event data
        const updatedEvent = await prisma.event.update({
            where: { id: parseInt(id) },
            data: {
                title,
                category,
                description,
                location,
                eventDate: eventDate ? new Date(eventDate) : undefined,
                ticketPrice: ticketPrice ? parseFloat(ticketPrice) : undefined,
                ticketPriceCents: ticketPrice ? Math.round(parseFloat(ticketPrice) * 100) : undefined,
                totalTickets: totalTickets ? parseInt(totalTickets) : undefined,
                image,
                isPublic: isPublic !== undefined ? isPublic : undefined,
                sellingFastThreshold: sellingFastThreshold !== undefined ? parseInt(sellingFastThreshold) : undefined,
                serviceFeeType: serviceFeeType || undefined,
                serviceFeeRate: serviceFeeRate !== undefined ? parseFloat(serviceFeeRate) : undefined,
                tags: tags ? JSON.stringify(tags) : undefined,
                highlights: highlights ? JSON.stringify(highlights) : undefined,
                pricingType: pricingType || undefined,
                updatedAt: new Date(),
                status: 'PENDING'
            }
        });

        // 2. Handle linked entities (Promo Codes & Images)
        if (promoCodes) {
            await prisma.promocode.deleteMany({ where: { eventId: parseInt(id) } });
            await prisma.promocode.createMany({
                data: promoCodes.map(pc => ({
                    eventId: parseInt(id),
                    code: pc.code.toUpperCase(),
                    discountType: (pc.discountType || pc.type).toUpperCase(),
                    discountValue: parseFloat(pc.discountValue || pc.value),
                    // Note: Discount logic stays same for now as we didn't add cents to promocode yet, 
                    // but we could if needed later.
                    maxUsage: pc.maxUsage || (pc.limit ? parseInt(pc.limit) : 0),
                    expiresAt: pc.expiresAt ? new Date(pc.expiresAt) : (pc.expiry ? new Date(pc.expiry) : null)
                }))
            });
        }

        if (galleryImages) {
            await prisma.eventimage.deleteMany({ where: { eventId: parseInt(id) } });
            await prisma.eventimage.createMany({
                data: galleryImages.map((imgUrl, index) => ({
                    eventId: parseInt(id),
                    imageUrl: imgUrl,
                    displayOrder: index
                }))
            });
        }

        // 3. Handle Ticket Releases (MULTI Pricing)
        if (pricingType === 'SINGLE' || (!pricingType && event.pricingType === 'SINGLE')) {
            // Delete all releases if switching to SINGLE
            await prisma.ticketrelease.deleteMany({ where: { eventId: parseInt(id) } });
        } else if (ticketReleases) {
            const existingReleases = await prisma.ticketrelease.findMany({ where: { eventId: parseInt(id) } });
            const existingIds = existingReleases.map(r => r.id);
            const providedIds = ticketReleases.filter(tr => tr.id).map(tr => parseInt(tr.id));

            // Delete releases not in provided list (only if 0 sold)
            const toDelete = existingIds.filter(eid => !providedIds.includes(eid));
            for (const delId of toDelete) {
                const soldCount = await prisma.ticket.count({ where: { ticketReleaseId: delId } });
                if (soldCount === 0) {
                    await prisma.ticketrelease.delete({ where: { id: delId } });
                } else {
                    // If tickets sold, just deactivate it instead of deleting
                    await prisma.ticketrelease.update({ where: { id: delId }, data: { isActive: false } });
                }
            }

            // Update or Create provided releases
            let foundActive = false;
            for (const tr of ticketReleases) {
                // Enforce single active tier: only the first one encountered as active stays active
                const trIsActive = tr.isActive ?? false;
                const finalActive = trIsActive && !foundActive;
                if (finalActive) foundActive = true;

                const releaseData = {
                    name: tr.name,
                    price: parseFloat(tr.price) || 0,
                    priceCents: Math.round((parseFloat(tr.price) || 0) * 100),
                    quantity: parseInt(tr.quantity) || 0,
                    releaseDate: tr.releaseDate ? new Date(tr.releaseDate) : null,
                    endDate: tr.endDate ? new Date(tr.endDate) : null,
                    isActive: finalActive
                };

                if (tr.id) {
                    await prisma.ticketrelease.update({
                        where: { id: parseInt(tr.id) },
                        data: releaseData
                    });
                } else if (parseInt(tr.quantity) > 0) {
                    await prisma.ticketrelease.create({
                        data: {
                            ...releaseData,
                            eventId: parseInt(id)
                        }
                    });
                }
            }
        }

        res.json(updatedEvent);
    } catch (error) {
        console.error('Error updating event:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route PATCH /api/organizer/releases/:id/toggle
 * @desc  Activate or deactivate a ticket release (single-active enforcement)
 */
router.patch('/releases/:id/toggle', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const releaseId = parseInt(req.params.id);
    try {
        const release = await prisma.ticketrelease.findUnique({
            where: { id: releaseId },
            include: { event: true }
        });

        if (!release) return res.status(404).json({ error: 'Ticket release not found' });
        if (release.event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const newActiveState = !release.isActive;

        // Atomic: if activating, deactivate all other releases for this event first
        await prisma.$transaction(async (tx) => {
            if (newActiveState) {
                // Deactivate all sibling releases
                await tx.ticketrelease.updateMany({
                    where: { eventId: release.eventId, id: { not: releaseId } },
                    data: { isActive: false }
                });
            }
            // Toggle this one
            await tx.ticketrelease.update({
                where: { id: releaseId },
                data: { isActive: newActiveState }
            });
        });

        // Return fresh event data
        const updatedEvent = await prisma.event.findUnique({
            where: { id: release.eventId },
            include: { ticketrelease: true }
        });

        res.json({ 
            message: `Release ${newActiveState ? 'activated' : 'deactivated'} successfully`,
            ticketReleases: updatedEvent.ticketrelease
        });
    } catch (error) {
        console.error('Error toggling release:', error);
        res.status(500).json({ error: 'Failed to update release status' });
    }
});

/**
 * @route PATCH /api/organizer/releases/:id
 * @desc  Edit a ticket release (name, qty, dates — price locked if sold > 0)
 */
router.patch('/releases/:id', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const releaseId = parseInt(req.params.id);
    const { name, price, quantity, releaseDate, endDate } = req.body;
    try {
        const release = await prisma.ticketrelease.findUnique({
            where: { id: releaseId },
            include: { event: true }
        });

        if (!release) return res.status(404).json({ error: 'Ticket release not found' });
        if (release.event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        if (quantity !== undefined && parseInt(quantity) < release.sold) {
            return res.status(400).json({ error: `Cannot reduce quantity below sold count (${release.sold})` });
        }

        const updateData = {
            name: name || release.name,
            quantity: quantity !== undefined ? parseInt(quantity) : release.quantity,
            releaseDate: releaseDate !== undefined ? (releaseDate ? new Date(releaseDate) : null) : release.releaseDate,
            endDate: endDate !== undefined ? (endDate ? new Date(endDate) : null) : release.endDate
        };

        // Price is locked after tickets are sold
        if (price !== undefined) {
            if (release.sold > 0) {
                return res.status(400).json({ error: 'Cannot change price after tickets have been sold for this tier' });
            }
            updateData.price = parseFloat(price);
            updateData.priceCents = Math.round(parseFloat(price) * 100);
        }

        const updated = await prisma.ticketrelease.update({
            where: { id: releaseId },
            data: updateData
        });

        // Recalculate event totalTickets from all releases
        const allReleases = await prisma.ticketrelease.findMany({ where: { eventId: release.eventId } });
        const newTotal = allReleases.reduce((sum, r) => sum + (r.id === releaseId ? parseInt(quantity || release.quantity) : r.quantity), 0);
        await prisma.event.update({
            where: { id: release.eventId },
            data: { totalTickets: newTotal }
        });

        res.json(updated);
    } catch (error) {
        console.error('Error editing release:', error);
        res.status(500).json({ error: 'Failed to update release' });
    }
});

/**
 * @route POST /api/organizer/events/:id/releases
 * @desc  Add a new ticket release to an existing MULTI event
 */
router.post('/events/:id/releases', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const eventId = parseInt(req.params.id);
    const { name, price, quantity, releaseDate, endDate, activateImmediately } = req.body;
    try {
        const event = await prisma.event.findUnique({
            where: { id: eventId },
            include: { ticketrelease: true }
        });

        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        if (event.pricingType !== 'MULTI') {
            return res.status(400).json({ error: 'Cannot add releases to a SINGLE pricing event' });
        }
        if (!name || price === undefined || !quantity) {
            return res.status(400).json({ error: 'Name, price, and quantity are required' });
        }

        const newRelease = await prisma.$transaction(async (tx) => {
            // If activating immediately, deactivate all existing releases first
            if (activateImmediately) {
                await tx.ticketrelease.updateMany({
                    where: { eventId },
                    data: { isActive: false }
                });
            }

            const created = await tx.ticketrelease.create({
                data: {
                    eventId,
                    name,
                    price: parseFloat(price),
                    priceCents: Math.round(parseFloat(price) * 100),
                    quantity: parseInt(quantity),
                    sold: 0,
                    isActive: activateImmediately ? true : false,
                    releaseDate: releaseDate ? new Date(releaseDate) : null,
                    endDate: endDate ? new Date(endDate) : null
                }
            });

            // Recalculate event totalTickets
            const allReleases = await tx.ticketrelease.findMany({ where: { eventId } });
            const newTotal = allReleases.reduce((sum, r) => sum + r.quantity, 0);
            await tx.event.update({ where: { id: eventId }, data: { totalTickets: newTotal } });

            return created;
        });

        res.status(201).json(newRelease);
    } catch (error) {
        console.error('Error adding release:', error);
        res.status(500).json({ error: 'Failed to add ticket release' });
    }
});

/**
 * @route DELETE /api/organizer/releases/:id
 * @desc  Delete a ticket release (blocked if any tickets sold)
 */
router.delete('/releases/:id', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const releaseId = parseInt(req.params.id);
    try {
        const release = await prisma.ticketrelease.findUnique({
            where: { id: releaseId },
            include: { event: true }
        });

        if (!release) return res.status(404).json({ error: 'Ticket release not found' });
        if (release.event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        if (release.sold > 0) {
            return res.status(400).json({ 
                error: `Cannot delete this tier — ${release.sold} ticket(s) have already been sold. Deactivate it instead.` 
            });
        }

        await prisma.ticketrelease.delete({ where: { id: releaseId } });

        // Recalculate event totalTickets
        const remaining = await prisma.ticketrelease.findMany({ where: { eventId: release.eventId } });
        const newTotal = remaining.reduce((sum, r) => sum + r.quantity, 0);
        await prisma.event.update({ where: { id: release.eventId }, data: { totalTickets: newTotal } });

        res.json({ message: 'Ticket release deleted successfully' });
    } catch (error) {
        console.error('Error deleting release:', error);
        res.status(500).json({ error: 'Failed to delete release' });
    }
});

/**
 * @route GET /api/organizer/reports
 * @desc  Get sales reports for the organizer's events
 */
router.get('/reports', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    try {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

        const events = await prisma.event.findMany({
            where: {
                organizerId: req.user.id
            }
        });

        const stats = events.reduce((acc, event) => {
            const gross = (event.ticketsSold || 0) * event.ticketPrice;
            const feeRate = event.serviceFeeRate || 0.03;
            const platformFee = gross * feeRate;

            acc.totalGross += gross;
            acc.totalFees += platformFee;

            // If organizer covers fee, net is gross - fee. If buyer covers, net is full ticket price.
            const net = event.serviceFeeType === 'ORGANIZER' ? (gross - platformFee) : gross;
            acc.totalNet += net;

            acc.totalTicketsSold += (event.ticketsSold || 0);
            acc.totalCapacity += event.totalTickets;
            return acc;
        }, { totalGross: 0, totalNet: 0, totalFees: 0, totalTicketsSold: 0, totalCapacity: 0 });

        // Calculate Revenue this month
        const recentTickets = await prisma.ticket.findMany({
            where: {
                event: { organizerId: req.user.id },
                purchasedAt: { gte: startOfMonth }
            },
            include: { event: { select: { ticketPrice: true } } }
        });

        const revenueThisMonth = recentTickets.reduce((sum, t) => sum + t.event.ticketPrice, 0);

        const report = {
            totalGross: stats.totalGross,
            totalNet: stats.totalNet,
            totalFees: stats.totalFees,
            ticketsSold: stats.totalTicketsSold,
            totalEvents: events.length,
            revenueThisMonth: `$${revenueThisMonth.toLocaleString()}`,
            totalCheckedIn: await prisma.ticket.count({
                where: {
                    event: { organizerId: req.user.id },
                    status: 'USED'
                }
            }),
            events: events.map(e => {
                const gross = (e.ticketsSold || 0) * e.ticketPrice;
                const fee = gross * (e.serviceFeeRate || 0.03);
                const net = e.serviceFeeType === 'ORGANIZER' ? (gross - fee) : gross;
                return {
                    id: e.id,
                    title: e.title,
                    grossRevenue: gross,
                    netPayout: net,
                    platformFee: fee,
                    feeType: e.serviceFeeType,
                    ticketsSold: (e.ticketsSold || 0),
                    totalTickets: e.totalTickets,
                    status: e.status
                };
            }),
            recentSales: await prisma.ticket.findMany({
                where: {
                    event: { organizerId: req.user.id }
                },
                take: 5,
                orderBy: { purchasedAt: 'desc' },
                include: {
                    event: { select: { title: true } }
                }
            })
        };

        res.json(report);
    } catch (error) {
        console.error('Error generating reports:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/organizer/events/:id/promos
 * @desc  Get all promo codes for an event
 */
router.get('/events/:id/promos', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const { id } = req.params;
    try {
        const event = await prisma.event.findUnique({ where: { id: parseInt(id) } });
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const promos = await prisma.promocode.findMany({
            where: { eventId: parseInt(id) },
            orderBy: { createdAt: 'desc' }
        });
        res.json(promos);
    } catch (error) {
        console.error('Error fetching promos:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route POST /api/organizer/events/:id/promos
 * @desc  Create a promo code for an event
 */
router.post('/events/:id/promos', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const { id } = req.params;
    const { code, type, value, limit, expiry } = req.body;
    if (!code || !type || !value) {
        return res.status(400).json({ error: 'code, type, and value are required' });
    }
    try {
        const event = await prisma.event.findUnique({ where: { id: parseInt(id) } });
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const promo = await prisma.promocode.create({
            data: {
                eventId: parseInt(id),
                code: code.toUpperCase(),
                discountType: type.toUpperCase(),
                discountValue: parseFloat(value),
                maxUsage: limit ? parseInt(limit) : 0,
                expiresAt: expiry ? new Date(expiry) : null
            }
        });
        res.status(201).json(promo);
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: 'A promo code with this code already exists for this event' });
        }
        console.error('Error creating promo:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route DELETE /api/organizer/events/:eventId/promos/:promoId
 * @desc  Delete a promo code
 */
router.delete('/events/:eventId/promos/:promoId', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const { eventId, promoId } = req.params;
    try {
        const event = await prisma.event.findUnique({ where: { id: parseInt(eventId) } });
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        await prisma.promocode.delete({ where: { id: parseInt(promoId) } });
        res.json({ message: 'Promo code deleted' });
    } catch (error) {
        console.error('Error deleting promo:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/organizer/events/:id/scanner-stats
 * @desc  Get live stats for ticket scanning
 */
router.get('/events/:id/scanner-stats', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const { id } = req.params;
    try {
        const event = await prisma.event.findUnique({
            where: { id: parseInt(id) },
            include: {
                _count: {
                    select: { ticket: true }
                }
            }
        });

        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const ticketStats = await prisma.ticket.groupBy({
            by: ['status'],
            where: { eventId: parseInt(id) },
            _count: true
        });

        const stats = {
            title: event.title,
            totalTickets: event.totalTickets,
            ticketsSold: event.ticketsSold,
            admitted: ticketStats.find(s => s.status === 'USED')?._count || 0,
            pending: ticketStats.find(s => s.status === 'UNUSED')?._count || 0,
            // Fetch last 10 scanned attendees
            recentAttendees: await prisma.ticket.findMany({
                where: { eventId: parseInt(id), status: 'USED' },
                take: 10,
                orderBy: { purchasedAt: 'desc' }, // In real app, we'd want 'scannedAt'
                select: {
                    id: true,
                    buyerName: true,
                    qrPayload: true,
                    status: true,
                    purchasedAt: true
                }
            })
        };

        res.json(stats);
    } catch (error) {
        console.error('Scanner stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route GET /api/organizer/events/:id/attendees
 * @desc  Get attendee list for an event
 */
router.get('/events/:id/attendees', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const { id } = req.params;
    try {
        const event = await prisma.event.findUnique({ where: { id: parseInt(id) } });
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const attendees = await prisma.ticket.findMany({
            where: { eventId: parseInt(id) },
            include: {
                ticketrelease: {
                    select: { name: true, price: true }
                }
            },
            orderBy: { purchasedAt: 'desc' }
        });

        res.json(attendees);
    } catch (error) {
        console.error('Error fetching attendees:', error);
        res.status(500).json({ error: 'Failed to load attendee list. Please try again.' });
    }
});

/**
 * @route PATCH /api/organizer/releases/:id/toggle
 * @desc  Toggle activation of a ticket release
 */
router.patch('/releases/:id/toggle', requireAuth, requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
    const { id } = req.params;
    try {
        const release = await prisma.ticketrelease.findUnique({
            where: { id: parseInt(id) },
            include: { event: true }
        });

        if (!release) return res.status(404).json({ error: 'Ticket release not found' });
        if (release.event.organizerId !== req.user.id && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const newStatus = !release.isActive;

        // If activating, deactivate all others first
        if (newStatus) {
            await prisma.ticketrelease.updateMany({
                where: { eventId: release.eventId, id: { not: parseInt(id) } },
                data: { isActive: false }
            });
        }

        const updatedRelease = await prisma.ticketrelease.update({
            where: { id: parseInt(id) },
            data: { isActive: newStatus }
        });

        // Recalculate event-level totals and price if pricingType is MULTI
        if (release.event.pricingType === 'MULTI') {
            const allReleases = await prisma.ticketrelease.findMany({
                where: { eventId: release.eventId, isActive: true }
            });

            let totalCapacity = 0;
            let minPrice = null;

            allReleases.forEach(r => {
                totalCapacity += r.quantity;
                if (minPrice === null || r.price < minPrice) {
                    minPrice = r.price;
                }
            });

            await prisma.event.update({
                where: { id: release.eventId },
                data: {
                    totalTickets: totalCapacity,
                    ticketPrice: minPrice || 0
                }
            });
        }

        res.json(updatedRelease);
    } catch (error) {
        console.error('Error toggling release status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
