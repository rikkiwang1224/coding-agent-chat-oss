export function getData(userId: string): { name: string; email: string } {
  return { name: "User " + userId, email: userId + "@example.com" };
}
