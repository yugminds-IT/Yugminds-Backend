import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class GetRoleService {
  constructor(private readonly db: DatabaseService) {}

  async getRole(userId: string) {
    const id = parseInt(userId, 10);
    if (isNaN(id)) {
      throw new NotFoundException('Invalid user ID');
    }
    const user = await this.db.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true, isSuperAdmin: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      isSuperAdmin: user.isSuperAdmin,
    };
  }
}
