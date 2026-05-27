// Application wiring — this file has type errors that need fixing

import { EventBus, type Listener, type Disposable } from "./event-bus.js";
import { InMemoryRepository, type Entity } from "./repository.js";

// --- Domain Types ---

interface User extends Entity {
  name: string;
  email: string;
  role: "admin" | "user";
}

interface AppEvents {
  "user:created": User;
  "user:updated": { user: User; changes: Partial<User> };
  "user:deleted": string;
  "system:error": Error;
}

// --- Bug 1: Wrong generic parameter ---
// EventBus should be parameterized with AppEvents
const bus = new EventBus();

// --- Bug 2: Listener type mismatch ---
// The handler's parameter type doesn't match the event data type
const onUserCreated: Listener<string> = (user) => {
  console.log(`User created: ${user.name}`);
};

// --- Bug 3: Missing Entity fields in create() call ---
// create() expects Omit<User, "id" | "createdAt"> but we're passing id and createdAt
const userRepo = new InMemoryRepository<User>();

async function createUser(name: string, email: string): Promise<User> {
  return userRepo.create({
    id: crypto.randomUUID(),
    name,
    email,
    role: "user",
    createdAt: new Date(),
  });
}

// --- Bug 4: Incorrect partial type in update ---
// Trying to update 'id' which is not allowed by the Partial<Omit<T, "id" | "createdAt">> constraint
async function promoteUser(userId: string): Promise<User> {
  return userRepo.update(userId, {
    role: "admin",
    id: "new-id",
  });
}

// --- Bug 5: Event emission with wrong payload type ---
// "user:deleted" expects a string (the user id), but we're passing the whole User object
async function deleteUser(userId: string): Promise<void> {
  const user = await userRepo.findById(userId);
  if (user) {
    await userRepo.delete(userId);
    bus.emit("user:deleted", user);
  }
}

// --- Correct usage (should remain unchanged) ---
function setupListeners(): Disposable[] {
  return [
    bus.on("user:created", onUserCreated),
    bus.on("system:error", (err) => console.error(err.message)),
  ];
}

export { bus, userRepo, createUser, promoteUser, deleteUser, setupListeners };
