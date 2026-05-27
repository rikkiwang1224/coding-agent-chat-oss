// Repository pattern with generic CRUD operations

export interface Entity {
  id: string;
  createdAt: Date;
}

export interface Repository<T extends Entity> {
  findById(id: string): Promise<T | undefined>;
  findAll(): Promise<T[]>;
  create(data: Omit<T, "id" | "createdAt">): Promise<T>;
  update(id: string, data: Partial<Omit<T, "id" | "createdAt">>): Promise<T>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryRepository<T extends Entity> implements Repository<T> {
  protected items: T[] = [];

  async findById(id: string): Promise<T | undefined> {
    return this.items.find((item) => item.id === id);
  }

  async findAll(): Promise<T[]> {
    return [...this.items];
  }

  async create(data: Omit<T, "id" | "createdAt">): Promise<T> {
    const entity = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    } as T;
    this.items.push(entity);
    return entity;
  }

  async update(id: string, data: Partial<Omit<T, "id" | "createdAt">>): Promise<T> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new Error(`Entity ${id} not found`);
    }
    this.items[index] = { ...this.items[index], ...data };
    return this.items[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }
}
