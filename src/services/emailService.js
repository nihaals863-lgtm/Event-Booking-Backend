const sgMail = require('@sendgrid/mail');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer');

// Configure SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// Puppeteer Singleton Browser Manager
let browserInstance = null;
async function getBrowser() {
    if (!browserInstance) {
        try {
            browserInstance = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            console.log('[BROWSER] Singleton browser instance launched.');
            
            browserInstance.on('disconnected', () => {
                console.log('[BROWSER] Browser disconnected, clearing instance.');
                browserInstance = null;
            });
        } catch (error) {
            console.error('[BROWSER_ERROR] Failed to launch browser:', error.message);
            throw error;
        }
    }
    return browserInstance;
}

/**
 * Helper to wrap a promise with a timeout
 */
function withTimeout(promise, ms, errorName) {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${errorName} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]);
}

/**
 * Generate QR Code as Base64 Data URL
 */
async function generateQRCode(payload, orderId = 'N/A') {
    try {
        console.log(`[QR_TRIGGER] Generating QR for payload: ${payload} orderId=${orderId}`);
        const dataUrl = await withTimeout(qrcode.toDataURL(payload), 5000, 'QR_GENERATION');
        console.log(`[QR_SUCCESS] orderId=${orderId}`);
        return dataUrl;
    } catch (error) {
        console.error(`[QR_ERROR] orderId=${orderId} error=${error.message}`);
        return null;
    }
}

/**
 * Generate a minimalist PDF ticket
 */
async function generateTicketPDF(eventData, attendeeData, orderData, qrBase64) {
    let page = null;
    try {
        console.log(`[PDF_TRIGGER] Generating PDF for orderId=${orderData.id}`);
        const browser = await getBrowser();
        page = await browser.newPage();

        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Helvetica', sans-serif; margin: 40px; color: #333; }
                    .ticket { border: 2px solid #EEE; padding: 20px; max-width: 600px; margin: auto; border-radius: 8px; }
                    .header { text-align: center; border-bottom: 2px solid #F5F5F5; padding-bottom: 20px; }
                    .event-name { font-size: 24px; font-weight: bold; margin: 10px 0; color: #1A1A1A; }
                    .details { margin: 20px 0; font-size: 14px; line-height: 1.6; }
                    .label { color: #888; text-transform: uppercase; font-size: 10px; font-weight: bold; letter-spacing: 1px; }
                    .qr-section { text-align: center; margin-top: 30px; }
                    .qr-image { width: 140px; height: 140px; border: 1px solid #EEE; padding: 10px; border-radius: 4px; }
                    .footer { text-align: center; font-size: 10px; color: #AAA; margin-top: 40px; border-top: 1px solid #F5F5F5; padding-top: 15px; }
                </style>
            </head>
            <body>
                <div class="ticket">
                    <div class="header">
                        <div class="label">Event Ticket</div>
                        <div class="event-name">${eventData.title}</div>
                    </div>
                    <div class="details">
                        <div style="float: left; width: 50%;">
                            <p><span class="label">Attendee</span><br><strong>${attendeeData.name}</strong></p>
                            <p><span class="label">Order ID</span><br>${orderData.id}</p>
                        </div>
                        <div style="float: left; width: 50%;">
                            <p><span class="label">Amount Paid</span><br>${orderData.amount}</p>
                        </div>
                        <div style="clear: both;"></div>
                    </div>
                    <div class="qr-section">
                        <img class="qr-image" src="${qrBase64}" />
                        <div class="label" style="margin-top: 10px;">Scan at Entry</div>
                    </div>
                    <div class="footer">
                        Powered by Event Platform • This ticket is valid for one entry only.
                    </div>
                </div>
            </body>
            </html>
        `;

        await withTimeout(page.setContent(htmlContent), 5000, 'PDF_CONTENT_SET');
        const pdfBuffer = await withTimeout(page.pdf({ format: 'A4', printBackground: true }), 5000, 'PDF_GENERATION');
        
        console.log(`[PDF_SUCCESS] orderId=${orderData.id} size=${pdfBuffer.length} bytes`);
        return pdfBuffer;
    } catch (error) {
        console.error(`[PDF_ERROR] orderId=${orderData.id} error=${error.message}`);
        return null;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

/**
 * Generic internal function to send emails safely.
 */
async function sendEmailRaw(msg, logType = 'unknown', orderId = 'N/A') {
    if (!process.env.SENDGRID_API_KEY || !FROM_EMAIL) {
        console.warn(`[EMAIL_SKIPPED] Missing SendGrid configuration. type=${logType} to=${msg.to}`);
        return;
    }

    try {
        console.log(`[EMAIL_DEBUG] type=${logType} orderId=${orderId} to=${msg.to}`);
        const response = await sgMail.send(msg);
        console.log(`[EMAIL_SUCCESS] status=${response[0].statusCode} to=${msg.to}`);
    } catch (error) {
        console.error(`[EMAIL_ERROR] to=${msg.to} message=${error.message}`);
        if (error.response) {
            console.error(error.response.body);
        }
    }
}

/**
 * Send ticket confirmation to the attendee.
 */
async function sendTicketConfirmation(attendeeData, orderData, tickets) {
    console.log(`[EMAIL_DEBUG] type=ticket_confirmation to=${attendeeData.email}`);
    // Generate QR and PDF conditionally based on first ticket
    const primaryTicket = tickets[0];
    let qrBase64 = null;
    let pdfBuffer = null;

    if (primaryTicket) {
        qrBase64 = await generateQRCode(primaryTicket.qrPayload, orderData.id);
        if (qrBase64) {
            pdfBuffer = await generateTicketPDF({ title: orderData.eventTitle }, attendeeData, orderData, qrBase64);
        }
    }

    const htmlTemplate = `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333; max-width: 600px; margin: auto; border: 1px solid #EEE; padding: 25px; border-radius: 12px; line-height: 1.6;">
            <div style="text-align: center; margin-bottom: 25px;">
                <h2 style="color: #1a73e8; margin: 0; font-size: 24px;">Order Confirmed!</h2>
                <p style="color: #666; font-size: 14px; margin-top: 5px;">Your tickets for ${orderData.eventTitle} are ready.</p>
            </div>
            
            <p>Hi <strong>${attendeeData.name}</strong>,</p>
            <p>Thank you for your purchase. We've attached your digital ticket to this email.</p>
            
            <div style="background: #F9FAFB; padding: 20px; border-radius: 8px; margin: 25px 0; border: 1px solid #F3F4F6;">
                <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 5px 0; color: #6B7280;">Order ID:</td>
                        <td style="padding: 5px 0; font-weight: bold; text-align: right;">${orderData.id}</td>
                    </tr>
                    <tr>
                        <td style="padding: 5px 0; color: #6B7280;">Quantity:</td>
                        <td style="padding: 5px 0; font-weight: bold; text-align: right;">${tickets.length} Ticket(s)</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 0 0 0; color: #6B7280; border-top: 1px solid #E5E7EB;">Total Amount:</td>
                        <td style="padding: 10px 0 0 0; font-weight: bold; color: #111827; font-size: 16px; text-align: right; border-top: 1px solid #E5E7EB;">${orderData.amount}</td>
                    </tr>
                </table>
            </div>

            ${qrBase64 ? `
            <div style="text-align: center; margin: 35px 0; padding: 20px; background: #FFF; border: 2px dashed #E5E7EB; border-radius: 12px;">
                <img src="${qrBase64}" width="160" height="160" style="display-block; margin: auto;" alt="Ticket QR Code" />
                <p style="font-size: 11px; color: #9CA3AF; margin-top: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Primary Admission QR Code</p>
            </div>
            ` : ''}

            <p style="font-size: 13px; color: #4B5563; text-align: center;">Please show the QR code above or the attached PDF ticket for entry at the event.</p>
            
            <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #EEE; text-align: center;">
                <p style="font-size: 12px; color: #9CA3AF; margin: 0;">Powered by <strong>Event Platform</strong></p>
            </div>
        </div>
    `;

    const msg = {
        to: attendeeData.email,
        from: FROM_EMAIL,
        subject: `Your Tickets for ${orderData.eventTitle} - ${orderData.id}`,
        text: `Hi ${attendeeData.name}, your purchase for ${orderData.eventTitle} was successful! Order ID: ${orderData.id}.`,
        html: htmlTemplate,
        attachments: pdfBuffer ? [
            {
                content: pdfBuffer.toString('base64'),
                filename: `ticket-${orderData.id}.pdf`,
                type: 'application/pdf',
                disposition: 'attachment'
            }
        ] : []
    };
 
    await sendEmailRaw(msg, 'ticket_confirmation', orderData.id);
}

/**
 * Notify organizer about a sale.
 */
async function sendOrganizerSaleNotification(organizerEmail, eventTitle, quantity, amount, orderId, buyerName, buyerEmail) {
    console.log(`[EMAIL_DEBUG] type=organizer_ticket_sold orderId=${orderId} to=${organizerEmail}`);
    if (!organizerEmail) {
        console.warn(`[EMAIL_SKIPPED] type=organizer_ticket_sold reason=missing_email`);
        return;
    }

    const buyerInfoHtml = buyerName ? `
        <div style="margin-top: 15px; padding: 10px; background: #f4f4f4; border-radius: 4px; font-size: 13px; color: #555;">
            <p style="margin: 0;"><strong>Buyer:</strong> ${buyerName}</p>
            ${buyerEmail ? `<p style="margin: 0;"><strong>Email:</strong> ${buyerEmail}</p>` : ''}
        </div>
    ` : '';

    const msg = {
        to: organizerEmail,
        from: FROM_EMAIL,
        subject: `Ticket Sold! - ${eventTitle}`,
        text: `Great news! You just sold ${quantity} ticket(s) for your event: ${eventTitle}. Amount: ${amount}. ${buyerName ? `Buyer: ${buyerName}` : ''}`,
        html: `
            <strong>Great news!</strong><br><br>
            You just sold ${quantity} ticket(s) for your event: <strong>${eventTitle}</strong>.<br>
            Amount: ${amount}.<br>
            ${buyerInfoHtml}
        `,
    };
    await sendEmailRaw(msg, 'organizer_ticket_sold', orderId);
}

/**
 * Notify admin about a new organizer registration.
 */
async function sendAdminNewOrganizerAlert(organizerData) {
    console.log(`[EMAIL_DEBUG] type=admin_new_organizer to=${ADMIN_EMAIL || 'MISSING'}`);
    if (!ADMIN_EMAIL) {
        console.warn(`[EMAIL_SKIPPED] type=admin_new_organizer reason=missing_admin_email`);
        return;
    }

    const timestamp = new Date().toLocaleString("en-AU", {
        dateStyle: "medium",
        timeStyle: "short"
    });

    const msg = {
        to: ADMIN_EMAIL,
        from: FROM_EMAIL,
        subject: `New Organizer Registration: ${organizerData.name}`,
        text: `A new organizer has registered: ${organizerData.name} (${organizerData.email}). Time: ${timestamp}`,
        html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #EEE; border-radius: 10px;">
                <h2 style="color: #1a73e8; margin-top: 0;">New Organizer Registration</h2>
                <p><strong>Name:</strong> ${organizerData.name}</p>
                <p><strong>Email:</strong> ${organizerData.email}</p>
                <p><strong>Time:</strong> ${timestamp}</p>
            </div>
        `,
    };
    await sendEmailRaw(msg, 'admin_new_organizer');
}

/**
 * Orchestrator for purchase-related emails to keep routes clean.
 */
function processPurchaseEmails({ attendeeEmail, attendeeName, orderId, totalAmount, eventTitle, organizerEmail, tickets }) {
    // FIRE-AND-FORGET
    (async () => {
        try {
            await Promise.allSettled([
                sendTicketConfirmation({ name: attendeeName, email: attendeeEmail }, { id: orderId, amount: totalAmount, eventTitle }, tickets),
                sendOrganizerSaleNotification(organizerEmail, eventTitle, tickets.length, totalAmount, orderId, attendeeName, attendeeEmail)
            ]);
        } catch (err) {
            console.error('[EMAIL_ORCHESTRATOR_ERROR] Failed during purchase email batch:', err.message);
        }
    })();
}

module.exports = {
    sendTicketConfirmation,
    sendOrganizerSaleNotification,
    sendAdminNewOrganizerAlert,
    processPurchaseEmails
};
