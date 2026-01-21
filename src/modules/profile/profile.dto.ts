import { IsString, IsOptional, MaxLength, MinLength, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProfileDto {
  @ApiProperty({ example: 'johndoe', minLength: 3, maxLength: 50 })
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  username: string;

  @ApiPropertyOptional({ example: 'John Doe' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  visibleName?: string;

  @ApiPropertyOptional({ example: 'I love reading manga!' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.jpg' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  @ApiPropertyOptional({ enum: ['en', 'es', 'pt'], default: 'es' })
  @IsOptional()
  @IsEnum(['en', 'es', 'pt'])
  language?: 'en' | 'es' | 'pt';
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'johndoe' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  username?: string;

  @ApiPropertyOptional({ example: 'John Doe' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  visibleName?: string;

  @ApiPropertyOptional({ example: 'Updated bio' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.jpg' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  @ApiPropertyOptional({ enum: ['en', 'es', 'pt'] })
  @IsOptional()
  @IsEnum(['en', 'es', 'pt'])
  language?: 'en' | 'es' | 'pt';

  @ApiPropertyOptional()
  @IsOptional()
  isAdultContent?: boolean;
}
