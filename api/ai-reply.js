import { Groq } from "groq-sdk"; // Add "groq-sdk": "^0.5.0" to package.json

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Helper: Proper Case
function toProperCase(str) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

module.exports = async (req, res) => {
    const { HUBSPOT_ACCESS_TOKEN, OPENPHONE_API_KEY } = process.env;

    try {
        // 1. Find deals where the customer replied (Status: "Reply Needed")
        const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HUBSPOT_ACCESS_TOKEN.trim()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filterGroups: [{
                    filters: [
                        { propertyName: 'sms_status', operator: 'EQ', value: 'Reply Needed' },
                        { propertyName: 'ai_bot_active', operator: 'EQ', value: 'true' }
                    ]
                }],
                properties: ['hubspot_owner_id', 'dog_data_json', 'k9___dog_name', 'what_is_the_breed_of_the_dog_s__'],
                limit: 10
            })
        });

        const { results: deals } = await searchRes.json();
        if (!deals || deals.length === 0) return res.status(200).json({ message: "No replies needed." });

        for (const deal of deals) {
            const dealId = deal.id;
            const ownerId = deal.properties.hubspot_owner_id;
            
            // 2. Get Contact & Conversation History
            const assocRes = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts`, {
                headers: { 'Authorization': `Bearer ${HUBSPOT_ACCESS_TOKEN.trim()}` }
            });
            const { results: contacts } = await assocRes.json();
            const contactId = contacts?.[0]?.id;
            if (!contactId) continue;

            // Fetch last 10 SMS messages (stored as 'communications' in HubSpot)
            const historyRes = await fetch(`https://api.hubapi.com/crm/v3/objects/communications?associatedObjectId=${contactId}&associatedObjectType=CONTACT&limit=10`, {
                headers: { 'Authorization': `Bearer ${HUBSPOT_ACCESS_TOKEN.trim()}` }
            });
            const { results: comms } = await historyRes.json();
            
            // Map history for Groq
            const chatHistory = comms.map(c => ({
                role: c.properties.hs_communication_channel_type === 'SMS' && c.properties.hs_communication_logged_from === 'CRM' ? "assistant" : "user",
                content: c.properties.hs_communication_body || ""
            })).reverse();

            // 3. Prepare AI Prompt
            const dogName = toProperCase(deal.properties.k9___dog_name) || "your dog";
            const dogData = deal.properties.dog_data_json || "{}";

            const systemPrompt = `
                Role: You are Alma, a Training Consultant at Dogwise Academy.
                Context: Today is ${new Date().toLocaleDateString()}. You are talking about ${dogName}.
                Dog Info: ${dogData}
                Guidelines: Be professional, empathetic, and concise. Use "I". 
                If they want a call, say you'll notify the trainer to call them. 
                Keep it to 1-2 sentences. 
                NEVER mention you are AI.
            `;

            // 4. Generate Response with Groq
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    ...chatHistory
                ],
                model: "llama-3.1-70b-versatile",
                temperature: 0.5,
            });

            const aiReply = completion.choices[0].message.content;

            // 5. Check if Call Task is needed
            if (aiReply.toLowerCase().includes("call") || aiReply.toLowerCase().includes("phone")) {
                await fetch('https://api.hubapi.com/crm/v3/objects/tasks', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${HUBSPOT_ACCESS_TOKEN.trim()}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        properties: {
                            hs_task_subject: `Call Request: ${dogName}`,
                            hs_task_body: `Customer requested a call via AI SMS.`,
                            hs_timestamp: new Date().toISOString(),
                            hubspot_owner_id: ownerId
                        },
                        associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 10 }] }]
                    })
                });
            }

            // 6. Send via OpenPhone (Using your existing phoneMap logic or simplified)
            // [Insert your OpenPhone fetch logic here using the senderPN logic from your first script]

            // 7. Update HubSpot Status to "Replied"
            await updateDeal(dealId, { sms_status: 'Replied' }, HUBSPOT_ACCESS_TOKEN);
        }

        res.status(200).json({ status: "Success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
