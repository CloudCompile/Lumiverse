export async function sendEmail(to: string, subject: string, template: string, data?: Record<string, any>): Promise<void> {
  console.log(`[Email] ${subject} → ${to}`);
  console.log(`[Email Template] ${template}`);
  if (data) {
    console.log("[Email Data]", JSON.stringify(data, null, 2));
  }
}
