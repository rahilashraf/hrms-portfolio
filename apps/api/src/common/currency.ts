/**
 * Domain-neutral ISO-4217 currency validation shared by bounded contexts (Compensation,
 * Payroll): three uppercase letters known to the runtime's currency list. Never converted.
 */
export function isIsoCurrency(code: string): boolean {
  return (
    /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf('currency').includes(code)
  );
}
