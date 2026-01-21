import { IsInt, IsOptional, IsBoolean, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBookmarkDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  comicId: number;

  @ApiPropertyOptional({ enum: ['reading', 'completed', 'dropped', 'plan_to_read'] })
  @IsOptional()
  @IsEnum(['reading', 'completed', 'dropped', 'plan_to_read'])
  status?: 'reading' | 'completed' | 'dropped' | 'plan_to_read';

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;
}

export class UpdateBookmarkDto {
  @ApiPropertyOptional({ enum: ['reading', 'completed', 'dropped', 'plan_to_read'] })
  @IsOptional()
  @IsEnum(['reading', 'completed', 'dropped', 'plan_to_read'])
  status?: 'reading' | 'completed' | 'dropped' | 'plan_to_read';

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;
}
