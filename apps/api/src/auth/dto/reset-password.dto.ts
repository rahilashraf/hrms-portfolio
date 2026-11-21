import { IsString, MaxLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @MaxLength(512)
  token!: string;

  @IsString()
  @MaxLength(1024)
  newPassword!: string;
}
