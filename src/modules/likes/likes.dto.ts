import { IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ToggleLikeDto {
  @ApiProperty({ example: 1, description: 'ID del comic' })
  @IsInt()
  comicId: number;
}
