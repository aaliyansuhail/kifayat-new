const BASE = "/api/defective-products";

export type DefectiveContact = {
  name: string;
  email: string;
  phone: string;
};

export async function submitDefectiveReport(formData: FormData) {
  const res = await fetch(BASE, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data as { success: boolean; report: unknown };
}

/**
 * The email/phone that will be attached to the report. Resolved server-side
 * from the account profile, falling back to the shipping details on past
 * orders, so the form never asks the customer to retype them.
 */
export async function getDefectiveContact(): Promise<DefectiveContact> {
  const res = await fetch(`${BASE}/contact`, { credentials: "include" });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data.contact as DefectiveContact;
}
