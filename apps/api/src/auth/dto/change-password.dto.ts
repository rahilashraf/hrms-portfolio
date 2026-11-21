import { IsString, MaxLength, MinLength } from 'class-validator';

/** The policy (12–128 characters) is checked by the service; this only bounds the input. */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  currentPassword!: string;

  @IsString()
  @MaxLength(1024)
  newPassword!: string;
}
