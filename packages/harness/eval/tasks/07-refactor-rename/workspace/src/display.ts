import { getData } from "./api.js";

export function printUser(id: string): void {
  const user = getData(id);
  console.log(`${user.name} <${user.email}>`);
}
