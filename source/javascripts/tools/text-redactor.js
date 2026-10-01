// Text Redactor: hide personal data in any text.
import { startTextTool } from "./text-tool.js";

const EXAMPLE = `Hi team,

Please send the signed contract to Sarah O'Connor at sarah.oconnor@acme-legal.com, or call her on +44 20 7946 0958. She lives at 221B Baker Street, London NW1 6XE, and her date of birth is 14 March 1987.

Dr. Rajesh Kumar from Northwind Traders in Toronto approved the payment of $4,200 to IBAN GB29 NWBK 6016 1331 9268 19. The company card ending 4111 1111 1111 1111 was used for the deposit.

For the audit: SSN 123-45-6789, server 192.168.1.20, API key sk-live-9f8a7b6c5d4e3f2a1b0c.

Thanks,
Miguel Ángel Fernández`;

startTextTool({ example: EXAMPLE, fileName: "redacted.txt" });
