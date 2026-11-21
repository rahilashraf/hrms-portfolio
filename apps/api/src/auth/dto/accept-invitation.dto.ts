import { IsString, MaxLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  @MaxLength(512)
  token!: string;

  @IsString()
  @MaxLength(1024)
  password!: string;
}
