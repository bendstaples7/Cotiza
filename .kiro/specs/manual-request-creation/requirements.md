# Requirements Document

## Introduction

The Quote Generation Engine currently relies on Jobber as the sole source of customer requests. Business users need the ability to create a customer request from scratch directly in the app — for scenarios where the customer contacted them via phone, email, in-person conversation, or any channel outside of Jobber's online booking form. This feature adds a manual request creation flow that captures structured customer and service information, then feeds it into the existing AI-powered quote generation pipeline.

## Glossary

- **Manual_Request_Form**: The UI form that allows a business user to enter customer details and service request information without relying on Jobber
- **Quote_Generation_Engine**: The existing AI-powered system that takes customer request text, images, catalog, templates, and rules to produce a quote draft
- **Request_Source**: The origin of a customer request — either "jobber" (pulled from Jobber) or "manual" (created directly in the app)
- **Customer_Details**: Structured information about the customer including name, phone number, email, and property address
- **Service_Description**: Free-text description of the work the customer is requesting
- **Quote_Input_Page**: The existing page (`/quotes/new`) where users select a Jobber request or paste text before generating a quote

## Requirements

### Requirement 1: Manual Request Entry Point

**User Story:** As a business user, I want to create a customer request from scratch, so that I can generate quotes for customers who haven't submitted a request through Jobber.

#### Acceptance Criteria

1. THE Quote_Input_Page SHALL display a "Create Manual Request" option alongside the existing Jobber request selector
2. WHEN the user selects "Create Manual Request", THE Quote_Input_Page SHALL display the Manual_Request_Form
3. WHEN Jobber is unavailable, THE Quote_Input_Page SHALL display the Manual_Request_Form as the primary input method

### Requirement 2: Customer Details Capture

**User Story:** As a business user, I want to enter customer contact information, so that the quote draft is associated with the correct customer.

#### Acceptance Criteria

1. THE Manual_Request_Form SHALL include a required field for customer name
2. THE Manual_Request_Form SHALL include optional fields for phone number, email address, and property address
3. WHEN the user submits the form with an empty customer name, THE Manual_Request_Form SHALL display a validation error and prevent submission
4. WHEN the user provides an email address, THE Manual_Request_Form SHALL validate that the email format is correct
5. THE Manual_Request_Form SHALL preserve entered data if the user navigates away and returns within the same session

### Requirement 3: Service Description Capture

**User Story:** As a business user, I want to describe the work requested by the customer, so that the AI can generate an accurate quote.

#### Acceptance Criteria

1. THE Manual_Request_Form SHALL include a required free-text field for the service description
2. WHEN the user submits the form with an empty service description, THE Manual_Request_Form SHALL display a validation error and prevent submission
3. THE Manual_Request_Form SHALL allow the service description field to contain at least 5000 characters
4. THE Manual_Request_Form SHALL support multi-line text entry for the service description

### Requirement 4: Image Attachment Support

**User Story:** As a business user, I want to attach reference images to a manual request, so that the AI has visual context for generating the quote.

#### Acceptance Criteria

1. THE Manual_Request_Form SHALL allow the user to upload reference images (JPEG, PNG, HEIC, WebP formats)
2. THE Manual_Request_Form SHALL allow up to 10 images per request
3. WHEN the user uploads an unsupported file format, THE Manual_Request_Form SHALL display an error message identifying the invalid file
4. WHEN the user exceeds the 10-image limit, THE Manual_Request_Form SHALL display an error message and reject the additional files

### Requirement 5: Quote Generation from Manual Request

**User Story:** As a business user, I want to generate a quote from my manually-entered request, so that I get the same AI-powered quote as I would from a Jobber request.

#### Acceptance Criteria

1. WHEN the user submits a valid Manual_Request_Form, THE Quote_Generation_Engine SHALL generate a quote draft using the provided service description and images
2. THE Quote_Generation_Engine SHALL include the customer name from the manual request on the resulting quote draft
3. WHEN the quote draft is generated from a manual request, THE Quote_Generation_Engine SHALL mark the Request_Source as "manual"
4. WHEN the quote draft is generated from a manual request, THE Quote_Generation_Engine SHALL apply the same product catalog matching, rules engine, and similar quote lookup as Jobber-sourced requests

### Requirement 6: Manual Request Persistence

**User Story:** As a business user, I want my manually-created requests to be saved, so that I can reference the original customer details from the quote draft.

#### Acceptance Criteria

1. WHEN a manual request is submitted, THE system SHALL persist the customer details and service description to the database
2. THE system SHALL associate the persisted manual request with the resulting quote draft
3. WHEN viewing a quote draft generated from a manual request, THE system SHALL display the original customer details (name, phone, email, address)
4. IF the database write fails during manual request creation, THEN THE system SHALL return a structured error with a recommended action to retry

### Requirement 7: Manual Request on Quote Draft Detail

**User Story:** As a business user, I want to see the customer details on the quote draft page, so that I have context about who the quote is for.

#### Acceptance Criteria

1. WHEN a quote draft was generated from a manual request, THE Quote_Draft_Page SHALL display the customer name, phone, email, and address
2. WHEN a quote draft was generated from a Jobber request, THE Quote_Draft_Page SHALL continue to display the Jobber request link as it does today
3. WHEN a quote draft has no associated request (legacy drafts), THE Quote_Draft_Page SHALL display only the customer request text
