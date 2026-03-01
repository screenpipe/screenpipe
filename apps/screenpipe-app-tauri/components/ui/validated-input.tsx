import React, { useState, useCallback, useMemo } from "react";
import { Input, InputProps } from "./input";
import { Label } from "./label";
import { cn } from "@/lib/utils";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { debounce, FieldValidationResult } from "@/lib/utils/validation";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

export interface ValidatedInputProps extends Omit<InputProps, "onChange"> {
  label?: string;
  helperText?: string;
  validation?: (value: string) => FieldValidationResult;
  onChange?: (value: string, isValid: boolean) => void;
  debounceMs?: number;
  showValidationIcon?: boolean;
  required?: boolean;
  maxLength?: number;
  minLength?: number;
}

export const ValidatedInput = React.forwardRef<HTMLInputElement, ValidatedInputProps>(
  ({
    label,
    helperText,
    validation,
    onChange,
    debounceMs = 300,
    showValidationIcon = true,
    required = false,
    maxLength,
    minLength,
    className,
    onBlur,
    onKeyDown,
    ...props
  }, ref) => {
    const [value, setValue] = useState(props.value?.toString() || "");
    const [validationResult, setValidationResult] = useState<FieldValidationResult>({ isValid: true });
    const [isTouched, setIsTouched] = useState(false);

    // Debounced validation function
    const debouncedValidation = useMemo(
      () => debounce((val: string) => {
        if (validation) {
          const result = validation(val);
          setValidationResult(result);
          onChange?.(val, result.isValid);
        } else {
          onChange?.(val, true);
        }
      }, debounceMs),
      [validation, onChange, debounceMs]
    );

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setValue(newValue);
      setIsTouched(true);
      
      // Immediate validation for basic checks
      if (required && !newValue.trim()) {
        setValidationResult({ isValid: false, error: `${label || "Field"} is required` });
      } else if (minLength && newValue.length < minLength) {
        setValidationResult({ isValid: false, error: `Minimum ${minLength} characters required` });
      } else if (maxLength && newValue.length > maxLength) {
        setValidationResult({ isValid: false, error: `Maximum ${maxLength} characters allowed` });
      } else {
        // Clear immediate errors for debounced validation
        setValidationResult({ isValid: true });
      }
      
      debouncedValidation(newValue);
    }, [required, minLength, maxLength, label, debouncedValidation]);

    const getValidationIcon = () => {
      if (!showValidationIcon || !isTouched) return null;
      
      if (!validationResult.isValid) {
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      }
      
      if (validationResult.warning) {
        return <Info className="h-4 w-4 text-warning" />;
      }
      
      if (validation && value) {
        return <CheckCircle2 className="h-4 w-4 text-success" />;
      }
      
      return null;
    };

    const getInputVariant = () => {
      if (!isTouched) return "";
      
      if (!validationResult.isValid) {
        return "border-destructive focus-visible:ring-destructive";
      }
      
      if (validationResult.warning) {
        return "border-warning focus-visible:ring-warning";
      }
      
      if (validation && value) {
        return "border-success focus-visible:ring-success";
      }
      
      return "";
    };

    const getMessage = () => {
      if (!isTouched) return helperText;
      return validationResult.error || validationResult.warning || helperText;
    };

    const getMessageColor = () => {
      if (!isTouched) return "text-muted-foreground";
      if (!validationResult.isValid) return "text-destructive";
      if (validationResult.warning) return "text-warning";
      return "text-muted-foreground";
    };

    return (
      <div className="space-y-2">
        {label && (
          <Label htmlFor={props.id} className="flex items-center gap-1">
            {label}
            {required && <span className="text-destructive">*</span>}
          </Label>
        )}
        
        <div className="relative">
          <Input
            ref={ref}
            {...props}
            value={value}
            onChange={handleChange}
            onBlur={(e) => {
              setIsTouched(true);
              onBlur?.(e);
            }}
            onKeyDown={(e) => {
              onKeyDown?.(e);
            }}
            className={cn(
              getInputVariant(),
              showValidationIcon && "pr-10",
              className
            )}
            maxLength={maxLength}
          />
          
          {showValidationIcon && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>{getValidationIcon()}</div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{validationResult.error || validationResult.warning || "Valid"}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}
        </div>
        
        {getMessage() && (
          <p className={cn("text-sm", getMessageColor())}>
            {getMessage()}
            {maxLength && (
              <span className="float-right text-muted-foreground">
                {value.length}/{maxLength}
              </span>
            )}
          </p>
        )}
      </div>
    );
  }
);

ValidatedInput.displayName = "ValidatedInput"; 