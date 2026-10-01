/**
 * A change's subject in words. The record keys a subject as `kind:id|what` ("resolution:25-04|date")
 * so that two documents can be compared; a person reads "Resolution 25-04, a date". The key stays
 * the key; this is only how it is shown.
 */
const KINDS: Record<string, string> = {
  resolution: "Resolution",
  ordinance: "Ordinance",
  docket: "Docket",
  tariff: "Tariff",
  contract: "Contract",
  agenda_item: "Item",
};
const WHAT: Record<string, string> = { date: "a date", money: "an amount", percent: "a percentage", count: "a count" };

export function subjectLabel(subject: string): string {
  const [key, what] = subject.split("|");
  const [kind, id] = (key ?? "").split(":");
  const name = `${KINDS[kind ?? ""] ?? kind ?? ""} ${id ?? ""}`.trim();
  return what ? `${name}, ${WHAT[what] ?? what}` : name;
}
