import { IsEmail } from 'class-validator';
import { Transform } from 'class-transformer';

export class ResendVerificationDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;
}
