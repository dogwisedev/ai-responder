import { Client } from '@hubspot/api-client';
import { Groq } from "groq-sdk";

const hubspot = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const toProperCase = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : "";

export default async function handler(req, res) {
    try {
        // 1. Fetch Deals where AI needs to reply
        const readyDeals = await hubspot.crm.deals.searchApi.doSearch({
            filterGroups: [{
                filters: [
                    { propertyName: 'sms_reply_status', operator: 'EQ', value: 'Reply Needed' },
                    { propertyName: 'ai_automation_active', operator: 'EQ', value: 'true' }
                ]
            }],
            properties: ['hubspot_owner_id', 'k9___dog_name', 'what_is_the_breed_of_the_dog_s__', 'firstname']
        });

        for (const deal of readyDeals.results) {
            const { hubspot_owner_id, k9___dog_name, what_is_the_breed_of_the_dog_s__: breed } = deal.properties;
            
            // 2. Fetch recent communications for history
            const associations = await hubspot.crm.deals.associationsApi.getAll(deal.id, 'contacts');
            const contactId = associations.results[0]?.id;
            
            const history = await hubspot.crm.objects.communicationsApi.getPage(10, undefined, [{
                filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: contactId }] }]
            }]);

            // Format history for AI
            const messages = history.results.map(m => ({
                role: m.properties.hs_communication_logged_from === 'CRM' ? 'assistant' : 'user',
                content: m.properties.hs_communication_body
            })).reverse();

            // 3. Identify Rep Name
            const owner = await hubspot.crm.owners.ownersApi.getById(hubspot_owner_id);
            const repName = owner.firstName === "Ariane" ? "Ari" : owner.firstName;

            // 4. Run Groq with Persona
            const dogInfo = k9___dog_name ? toProperCase(k9___dog_name) : (breed ? `your ${breed.toLowerCase()}` : "your dog");
            
            const response = await groq.chat.completions.create({
                model: "llama-3.1-70b-versatile",
                messages: [
                    { role: "system", content: `You are ${repName} from Dogwise Academy. Be empathetic. Talk about ${dogInfo}. If they want a call, agree and say you'll set it up. Today is ${new Date().toDateString()}.` },
                    ...messages
                ],
                tools: [{
                    type: "function",
                    function: {
                        name: "create_call_task",
                        description: "Schedule a callback task for the rep",
                        parameters: { type: "object", properties: { date: { type: "string" }, time: { type: "string" } } }
                    }
                }]
            });

            const aiMessage = response.choices[0].message;

            // 5. Handle Tool Call (Task Creation)
            if (aiMessage.tool_calls) {
                await hubspot.crm.tasks.basicApi.create({
                    properties: {
                        hs_task_subject: `Call Request for ${dogInfo}`,
                        hubspot_owner_id: hubspot_owner_id,
                        hs_timestamp: new Date().toISOString()
                    }
                });
            }

            // 6. Send via OpenPhone & Clear Status
            // [Insert OpenPhone Send Logic here]
            
            await hubspot.crm.deals.basicApi.update(deal.id, {
                properties: { sms_reply_status: 'Replied' }
            });
        }

        res.status(200).send("Processed");
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
