import { Injectable } from '@nestjs/common';

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string; // e.g. 'CREATE_TEACHER', 'DELETE_STUDENT'
  entity: string; // e.g. 'Teacher', 'Student', 'Course'
  entityId?: string;
  performedBy?: string; // admin user email or id
  details?: string; // human-readable summary
}

let _seq = 0;

@Injectable()
export class AuditService {
  private readonly entries: AuditEntry[] = [];
  private readonly maxEntries = 1000;

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    this.entries.push({
      id: String(++_seq),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  list(limit = 100): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
